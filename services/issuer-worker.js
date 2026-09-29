const fs = require("fs");
const path = require("path");
const { hashValues, fieldHex, checkRanges, TREE_DEPTH } = require("../lib/poe");
const { normalizePolicy, hashFunctions, policyHash } = require("../lib/poe-v2");
const { ALG, loadKey, encryptJson, decryptJson } = require("../lib/batch-crypto");
const { normalizeEntries, buildBatchEntries } = require("../lib/batch-entries");

/**
 * Copus-run issuer worker: a one-shot job (cron, not a daemon) that turns the
 * backend's private receipt export into committed evidence batches.
 *
 * For one campaign it pages receipts out of the Copus backend, builds a
 * depth-8 Poseidon Merkle tree per page, commits (root, ruleHash) to
 * EvidenceRegistry, and writes every subject's leaf index and path back into
 * t_poe_receipt. Ordering is strict:
 *
 *   1. commit  — if the chain rejects the batch nothing is written anywhere;
 *                no receipt may ever reference a batch that is not on-chain.
 *   2. archive — optional encrypted copy of the exact write-back body, so a
 *                failed write-back can be replayed without touching the chain.
 *   3. write-back — retried with backoff; on final failure the run stops and
 *                prints batchId and root so an operator can `--replay`.
 *
 * Commits are serialized (one awaited transaction at a time) so the issuer
 * key's nonces never race. Receipts and subject secrets are never logged.
 */

const PAGE_SIZE = 256;
const DEFAULT_MAX_BATCHES = 20;
const WRITE_BACK_ATTEMPTS = 3;
const WRITE_BACK_BACKOFF_MS = 500;
const HTTP_TIMEOUT_MS = 30_000;

const RECEIPT_FIELDS = ["subjectSecret", "eventCount", "totalDwellSeconds", "observedAt", "receiptNonce"];
const POLICY_FIELDS = ["minEvents", "minDwellSeconds", "notBefore"];

function decimal(name, value) {
  if (value === undefined || value === null) throw new Error(`${name} is required`);
  const text = typeof value === "bigint" ? value.toString() : String(value);
  if (!/^\d+$/.test(text)) throw new Error(`${name} must be a non-negative decimal integer`);
  return text;
}

function pick(name, source, fields) {
  if (!source || typeof source !== "object") throw new Error(`${name} is required`);
  return Object.fromEntries(fields.map((field) => [field, decimal(`${name}.${field}`, source[field])]));
}

async function ruleHashOf(policy) {
  if (Number(policy?.version) === 2) {
    const normalized = normalizePolicy(policy);
    return fieldHex(policyHash(normalized, await hashFunctions()));
  }
  const clean = pick("policy", policy, POLICY_FIELDS);
  checkRanges(clean);
  return fieldHex(await hashValues(POLICY_FIELDS.map((field) => clean[field])));
}

// One export page → the exact write-back body minus the on-chain facts.
async function prepareBatch(rows, policy) {
  const entries = normalizeEntries(rows).map((entry, index) => {
    if (typeof entry.subjectRef !== "string" || entry.subjectRef.length === 0 || entry.subjectRef.length > 128) {
      throw new Error(`receipts[${index}].subjectRef is required`);
    }
    const receipt = pick(`receipts[${index}].receipt`, entry.receipt, RECEIPT_FIELDS);
    if (Number(policy?.version) === 2) {
      if (!Array.isArray(entry.receipt.facts) || entry.receipt.facts.length !== policy.rules.length) {
        throw new Error(`receipts[${index}].receipt.facts must match the policy rules`);
      }
      receipt.facts = entry.receipt.facts.map((value, factIndex) => decimal(`receipts[${index}].receipt.facts[${factIndex}]`, value));
    }
    return { subjectRef: entry.subjectRef, receipt };
  });
  const seen = new Set();
  for (const { subjectRef } of entries) {
    if (seen.has(subjectRef)) throw new Error(`duplicate subjectRef in export page: ${subjectRef}`);
    seen.add(subjectRef);
  }
  const built = await buildBatchEntries(entries, policy);
  return { root: built.batch.root, size: entries.length, entries: built.entries };
}

function writeBackBody({ campaignId, batchId, chainId, root, ruleHash, transactionHash, size, entries }) {
  return {
    campaignId: decimal("campaignId", campaignId),
    batchId: decimal("batchId", batchId),
    chainId: Number(chainId),
    evidenceRoot: BigInt(root).toString(),
    ruleHash,
    transactionHash,
    size,
    entries,
  };
}

// Summary line for logs and errors: on-chain facts only, never receipt data.
function batchSummary(body) {
  const { campaignId, batchId, evidenceRoot, ruleHash, size, transactionHash } = body;
  return { campaignId, batchId, root: evidenceRoot, ruleHash, size, transactionHash };
}

async function writeBackWithRetry(writeBack, body, { attempts = WRITE_BACK_ATTEMPTS, sleep = defaultSleep, warn = console.error } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await writeBack(body);
    } catch (error) {
      lastError = error;
      warn(JSON.stringify({ event: "write_back_failed", attempt, attempts, batchId: body.batchId, error: error.message }));
      if (attempt < attempts) await sleep(WRITE_BACK_BACKOFF_MS * 2 ** (attempt - 1));
    }
  }
  const failure = new Error(
    `write-back failed after ${attempts} attempts for campaign ${body.campaignId} batch ${body.batchId} ` +
    `(root ${body.evidenceRoot}, tx ${body.transactionHash}): ${lastError.message}. ` +
    "The batch is committed on-chain; re-run the write-back alone with --replay <archive file>."
  );
  failure.batch = batchSummary(body);
  failure.cause = lastError;
  throw failure;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Core run loop. Every I/O piece is injected:
 *   fetchExport({ campaignId, limit, cursor }) → { campaignId, policy, receipts, nextCursor }
 *   commit({ root, policyHash })               → { batchId, transactionHash, chainId? }
 *   writeBack(body)                            → resolves on 2xx, throws otherwise
 *   archive(body)                              → optional; called after commit, before write-back
 */
async function runIssuer({
  campaignId, fetchExport, commit, writeBack, archive, policy: policyOverride,
  maxBatches = DEFAULT_MAX_BATCHES, chainId: defaultChainId, log = console.log, sleep = defaultSleep, warn = console.error,
}) {
  if (typeof fetchExport !== "function" || typeof commit !== "function" || typeof writeBack !== "function") {
    throw new Error("fetchExport, commit and writeBack are required");
  }
  const campaign = decimal("campaignId", campaignId);
  const cap = Number(maxBatches);
  if (!Number.isInteger(cap) || cap < 1) throw new Error("maxBatches must be a positive integer");

  const batches = [];
  let cursor;
  let exhausted = false;
  let ruleHash;
  let scannedPages = 0;
  while (batches.length < cap) {
    if (++scannedPages > 1000) break;
    const page = await fetchExport({ campaignId: campaign, limit: PAGE_SIZE, cursor });
    if (!page || typeof page !== "object") throw new Error("export returned no page");
    if (page.campaignId !== undefined && page.campaignId !== null && decimal("export.campaignId", page.campaignId) !== campaign) {
      throw new Error(`export returned campaign ${page.campaignId}, expected ${campaign}`);
    }
    const rows = page.receipts;
    if (rows !== undefined && !Array.isArray(rows)) throw new Error("export.receipts must be an array");
    if (!rows || rows.length === 0) {
      if (page.nextCursor === null || page.nextCursor === undefined) { exhausted = true; break; }
      const next = decimal("export.nextCursor", page.nextCursor);
      if (cursor !== undefined && BigInt(next) <= BigInt(cursor)) throw new Error("export cursor did not advance");
      cursor = next;
      continue;
    }
    if (rows.length > PAGE_SIZE) throw new Error(`export returned ${rows.length} receipts; limit is ${PAGE_SIZE}`);

    // The rule hash is a property of the campaign, so it is the same for every
    // page; it is still recomputed per page so a policy that changes mid-run
    // (it must not) fails loudly instead of committing a mismatched batch.
    const pageRuleHash = await ruleHashOf(policyOverride ?? page.policy);
    if (page.ruleHash && page.ruleHash.toLowerCase() !== pageRuleHash.toLowerCase()) {
      throw new Error("export ruleHash does not match its policy preimage");
    }
    if (ruleHash && pageRuleHash !== ruleHash) throw new Error("export policy changed between pages; aborting");
    ruleHash = pageRuleHash;

    const prepared = await prepareBatch(rows, policyOverride ?? page.policy);
    const rootHex = fieldHex(prepared.root);

    // 1. Commit. Any failure here aborts the run before a single write-back.
    const committed = await commit({ root: rootHex, policyHash: ruleHash });
    if (!committed || committed.batchId === undefined || committed.batchId === null) {
      throw new Error("commit returned no batchId");
    }
    const body = writeBackBody({
      campaignId: campaign, batchId: committed.batchId, chainId: committed.chainId ?? defaultChainId,
      root: prepared.root, ruleHash, transactionHash: committed.transactionHash ?? null, size: prepared.size, entries: prepared.entries,
    });
    if (!Number.isInteger(body.chainId)) throw new Error("chainId is required (from commit or options)");
    log(JSON.stringify(batchSummary(body)));

    // 2. Archive before write-back so a failed write-back is always replayable.
    if (archive) await archive(body);

    // 3. Write back; retries live inside, and a final failure stops the run.
    await writeBackWithRetry(writeBack, body, { sleep, warn });
    batches.push(batchSummary(body));

    if (page.nextCursor === null || page.nextCursor === undefined) { exhausted = true; break; }
    const next = decimal("export.nextCursor", page.nextCursor);
    if (cursor !== undefined && BigInt(next) <= BigInt(cursor)) throw new Error("export cursor did not advance");
    cursor = next;
  }
  return { campaignId: campaign, ruleHash: ruleHash ?? null, batches, exhausted, nextCursor: exhausted ? null : cursor };
}

// ---- Real I/O ---------------------------------------------------------------

// The Copus backend answers HTTP 200 with a ResultTO envelope even on errors:
// { status: 1, msg, data } on success, { status: <non-1>, msg, data } on failure.
// A plain JSON body (no status/data keys) is accepted too.
async function readBackendJson(response, label) {
  const text = await response.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = null; }
  if (!response.ok) {
    const reason = parsed && typeof parsed.msg === "string" ? parsed.msg : `HTTP ${response.status}`;
    throw new Error(`${label} failed: ${reason}`);
  }
  if (parsed === null || typeof parsed !== "object") throw new Error(`${label} returned a non-JSON body`);
  if (Object.prototype.hasOwnProperty.call(parsed, "status")) {
    if (Number(parsed.status) !== 1) throw new Error(`${label} failed: ${parsed.msg || `status ${parsed.status}`}`);
    return Object.prototype.hasOwnProperty.call(parsed, "data") ? parsed.data : parsed;
  }
  return parsed;
}

function createExportFetcher({ baseUrl, token, exportPath = "/evidence/export", fetchImpl = globalThis.fetch }) {
  if (!baseUrl || !token) throw new Error("COPUS_INTERNAL_URL and COPUS_INTERNAL_TOKEN are required");
  return async function fetchExport({ campaignId, limit = PAGE_SIZE, cursor }) {
    const url = new URL(exportPath, baseUrl);
    url.searchParams.set("campaignId", String(campaignId));
    url.searchParams.set("limit", String(limit));
    if (cursor !== undefined && cursor !== null) url.searchParams.set("cursor", String(cursor));
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    return readBackendJson(response, "receipt export");
  };
}

function createWriteBack({ baseUrl, token, writeBackPath = "/evidence/writeback", fetchImpl = globalThis.fetch }) {
  if (!baseUrl || !token) throw new Error("COPUS_INTERNAL_URL and COPUS_INTERNAL_TOKEN are required");
  return async function writeBack(body) {
    const url = new URL(writeBackPath, baseUrl);
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    return readBackendJson(response, "receipt write-back");
  };
}

// contract: an ethers.Contract for EvidenceRegistry connected to the issuer signer.
function createCommitter({ contract, confirmations = 1, chainId }) {
  if (!contract) throw new Error("contract is required");
  return async function commit({ root, policyHash }) {
    const tx = await contract.commitEvidence(root, policyHash);
    const receipt = await tx.wait(confirmations);
    if (!receipt || receipt.status === 0) throw new Error(`commitEvidence reverted (tx ${tx.hash})`);
    let event;
    for (const entry of receipt.logs || []) {
      let parsed;
      try { parsed = contract.interface.parseLog(entry); } catch { continue; }
      if (parsed && parsed.name === "EvidenceCommitted") { event = parsed; break; }
    }
    if (!event) throw new Error(`EvidenceCommitted event not found in tx ${tx.hash}`);
    const { batchId, root: emittedRoot, policyHash: emittedPolicy } = event.args;
    if (BigInt(emittedRoot) !== BigInt(root) || BigInt(emittedPolicy) !== BigInt(policyHash)) {
      throw new Error(`EvidenceCommitted in tx ${tx.hash} does not match the submitted root/policyHash`);
    }
    return { batchId: BigInt(batchId).toString(), transactionHash: receipt.hash ?? tx.hash, chainId };
  };
}

function archiveFileName(chainId, batchId) {
  return `batch-${Number(chainId)}-${decimal("batchId", batchId)}.enc.json`;
}

function createArchiver({ dir, key }) {
  if (!dir) throw new Error("BATCH_ARCHIVE_DIR is required for archiving");
  const keyBuffer = Buffer.isBuffer(key) ? key : loadKey(key);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return async function archive(body) {
    const file = path.join(dir, archiveFileName(body.chainId, body.batchId));
    // Never overwrite: a batch id maps to exactly one on-chain commitment.
    fs.writeFileSync(file, `${JSON.stringify(encryptJson(body, keyBuffer))}\n`, { flag: "wx", mode: 0o600 });
    return file;
  };
}

// --replay: read one archived batch and do only the write-back.
async function replayBatch({ file, key, writeBack, log = console.log, sleep = defaultSleep, warn = console.error }) {
  const stat = fs.statSync(file);
  if (stat.mode & 0o077) throw new Error(`${file} must be owner-only (run: chmod 600 ${file})`);
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  let body;
  if (parsed && parsed.alg === ALG) {
    if (!key) throw new Error("archive is encrypted but BATCH_ENCRYPTION_KEY is not set");
    body = decryptJson(parsed, Buffer.isBuffer(key) ? key : loadKey(key));
  } else {
    body = parsed;
  }
  for (const field of ["campaignId", "batchId", "chainId", "evidenceRoot", "ruleHash", "entries"]) {
    if (body?.[field] === undefined || body[field] === null) throw new Error(`archive is missing ${field}`);
  }
  if (!Array.isArray(body.entries) || body.entries.length === 0) throw new Error("archive has no entries");
  await writeBackWithRetry(writeBack, body, { sleep, warn });
  log(JSON.stringify({ ...batchSummary(body), replayed: true }));
  return batchSummary(body);
}

// ---- CLI --------------------------------------------------------------------

function parseArgs(argv) {
  const args = { campaign: undefined, replay: undefined };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--campaign") args.campaign = argv[++i];
    else if (argv[i].startsWith("--campaign=")) args.campaign = argv[i].slice("--campaign=".length);
    else if (argv[i] === "--replay") args.replay = argv[++i];
    else if (argv[i].startsWith("--replay=")) args.replay = argv[i].slice("--replay=".length);
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return args;
}

async function main(argv = process.argv.slice(2), env = process.env) {
  require("dotenv").config({ quiet: true });
  const args = parseArgs(argv);
  for (const key of ["COPUS_INTERNAL_URL", "COPUS_INTERNAL_TOKEN", "EVIDENCE_EXPORT_PATH", "EVIDENCE_WRITEBACK_PATH"]) {
    if (!env[key]) throw new Error(`${key} is required`);
  }
  const writeBack = createWriteBack({ baseUrl: env.COPUS_INTERNAL_URL, token: env.COPUS_INTERNAL_TOKEN,
    writeBackPath: env.EVIDENCE_WRITEBACK_PATH });
  const key = env.BATCH_ENCRYPTION_KEY ? loadKey(env.BATCH_ENCRYPTION_KEY) : null;

  if (args.replay) {
    return replayBatch({ file: args.replay, key, writeBack });
  }

  const campaignId = args.campaign ?? env.CAMPAIGN_ID;
  if (!campaignId) throw new Error("CAMPAIGN_ID (or --campaign) is required");
  for (const name of ["RPC_URL", "EVIDENCE_REGISTRY_ADDRESS", "ISSUER_PRIVATE_KEY"]) {
    if (!env[name]) throw new Error(`${name} is required`);
  }
  const { ethers } = require("ethers");
  const artifact = require("../artifacts/contracts/EvidenceRegistry.sol/EvidenceRegistry.json");
  const provider = new ethers.JsonRpcProvider(env.RPC_URL);
  const signer = new ethers.Wallet(env.ISSUER_PRIVATE_KEY, provider);
  const chainId = Number((await provider.getNetwork()).chainId);
  const contract = new ethers.Contract(env.EVIDENCE_REGISTRY_ADDRESS, artifact.abi, signer);
  const confirmations = Number(env.CONFIRMATIONS || 1);
  if (!Number.isInteger(confirmations) || confirmations < 1) throw new Error("CONFIRMATIONS must be a positive integer");

  const archive = key ? createArchiver({ dir: env.BATCH_ARCHIVE_DIR || path.join(process.cwd(), "batch-archive"), key }) : undefined;
  if (!key && env.BATCH_ARCHIVE_DIR) throw new Error("BATCH_ARCHIVE_DIR is set but BATCH_ENCRYPTION_KEY is not; archives are never written in plaintext");

  const result = await runIssuer({
    campaignId,
    fetchExport: createExportFetcher({ baseUrl: env.COPUS_INTERNAL_URL, token: env.COPUS_INTERNAL_TOKEN,
      exportPath: env.EVIDENCE_EXPORT_PATH }),
    commit: createCommitter({ contract, confirmations, chainId }),
    writeBack,
    archive,
    chainId,
    maxBatches: env.MAX_BATCHES ? Number(env.MAX_BATCHES) : DEFAULT_MAX_BATCHES,
  });
  console.log(JSON.stringify({ event: "run_complete", campaignId: result.campaignId, batches: result.batches.length, exhausted: result.exhausted, nextCursor: result.nextCursor }));
  return result;
}

module.exports = {
  PAGE_SIZE, DEFAULT_MAX_BATCHES, WRITE_BACK_ATTEMPTS, TREE_DEPTH,
  runIssuer, prepareBatch, ruleHashOf, writeBackBody, writeBackWithRetry, replayBatch,
  readBackendJson, createExportFetcher, createWriteBack, createCommitter, createArchiver, archiveFileName, parseArgs, main,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    if (error.batch) console.error(JSON.stringify({ event: "write_back_abandoned", ...error.batch }));
    process.exitCode = 1;
  });
}
