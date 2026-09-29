const http = require("http");
const { ethers } = require("ethers");
const artifact = require("../artifacts/contracts/FundedSponsorshipCampaigns.sol/FundedSponsorshipCampaigns.json");
const v2Artifact = require("../artifacts/contracts/FundedSponsorshipCampaignsV2.sol/FundedSponsorshipCampaignsV2.json");
const { SqliteCheckpointStore } = require("./settlement-indexer");
const { parseBearerTokens, validBearer } = require("./bearer");

const HOUR_MS = 60 * 60 * 1000;
const BALANCE_CACHE_MS = 30_000;
const DEFAULTS = { maxClaimsPerHour: 600, minBalanceWei: 0n, confirmTimeoutMs: 120_000, maxRebroadcasts: 2 };
// Custom errors claim() can raise; a simulation that hits one is reported by name.
const KNOWN_REVERTS = new Set([
  "AlreadyClaimed", "EpochMismatch", "RuleMismatch", "CampaignFull", "CampaignClosed",
  "CampaignNotStarted", "InvalidProof", "CampaignMissing", "EvidenceTooOld",
]);

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; if (body.length > 100_000) request.destroy(); });
    request.on("end", () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
    request.on("error", reject);
  });
}

class HttpError extends Error {
  constructor(statusCode, message) { super(message); this.statusCode = statusCode; }
}

/** Reads the relayer tuning knobs from the environment; handler options override these. */
function optionsFromEnv(env = process.env) {
  const number = (key, fallback) => (env[key] === undefined || env[key] === "" ? fallback : Number(env[key]));
  return {
    maxClaimsPerHour: number("RELAYER_MAX_CLAIMS_PER_HOUR", DEFAULTS.maxClaimsPerHour),
    minBalanceWei: env.RELAYER_MIN_BALANCE_WEI ? BigInt(env.RELAYER_MIN_BALANCE_WEI) : DEFAULTS.minBalanceWei,
    confirmTimeoutMs: number("RELAYER_CONFIRM_TIMEOUT_MS", DEFAULTS.confirmTimeoutMs),
    maxRebroadcasts: number("RELAYER_MAX_REBROADCASTS", DEFAULTS.maxRebroadcasts),
  };
}

// Nonce serialization. Every broadcast runs through this one in-process FIFO, so
// two concurrent POSTs can never both read the same pending nonce from the node.
// A promise chain was chosen over ethers' NonceManager on purpose: NonceManager
// increments its local counter before the send resolves, so a send that fails
// (RPC error, underpriced, estimateGas revert) leaves a permanent nonce gap that
// stalls every later transaction until someone calls reset(). With the queue the
// wallet asks the node for the pending nonce on each send, and because sends are
// strictly sequential the node has always seen the previous transaction by then.
// The chain never poisons itself: a rejected task is caught before it becomes the
// next task's predecessor.
function createSendQueue() {
  let tail = Promise.resolve();
  let depth = 0;
  return {
    get depth() { return depth; },
    run(task) {
      depth += 1;
      const result = tail.then(task);
      tail = result.then(() => { depth -= 1; }, () => { depth -= 1; });
      return result;
    },
  };
}

/** Sliding one-hour window over broadcasts: the relayer's hard cap on gas spend per hour. */
function createHourlyBudget(limit, now) {
  const stamps = [];
  const prune = () => { const cutoff = now() - HOUR_MS; while (stamps.length && stamps[0] <= cutoff) stamps.shift(); };
  return {
    used() { prune(); return stamps.length; },
    exhausted() { return limit > 0 && this.used() >= limit; }, // 0 or unset disables the guard
    reserve() {
      if (this.exhausted()) throw new HttpError(429, "relayer hourly claim budget exhausted");
      stamps.push(now());
    },
  };
}

/** Balance floor with a 30 s cache so a burst of claims costs one eth_getBalance, not one per request. */
function createBalanceGuard({ provider, signerAddress, minBalanceWei, now }) {
  let cached = null;
  let checkedAt = -Infinity;
  return {
    get last() { return cached; },
    async check() {
      if (!(minBalanceWei > 0n)) return;
      if (!provider || !signerAddress) throw new HttpError(503, "relayer balance guard is misconfigured");
      if (now() - checkedAt >= BALANCE_CACHE_MS) {
        cached = BigInt(await provider.getBalance(signerAddress));
        checkedAt = now();
      }
      if (cached < minBalanceWei) throw new HttpError(503, "relayer wallet balance below reserve");
    },
  };
}

/** True when the failure is the EVM rejecting the call rather than the RPC failing to answer. */
function isRevert(error) {
  return Boolean(error && (error.code === "CALL_EXCEPTION" || error.revert || error.errorName ||
    (typeof error.reason === "string" && error.reason) || error.data));
}

function revertReason(error) {
  const name = error?.revert?.name || error?.errorName || (typeof error?.reason === "string" ? error.reason : "");
  if (name && KNOWN_REVERTS.has(name)) return name;
  return name || error?.shortMessage || error?.message || "simulation reverted";
}

/** Default receipt wait: resolves the receipt, null when the timeout elapses, throws for revert/replacement. */
async function defaultWait(tx, timeoutMs) {
  try {
    return await tx.wait(1, timeoutMs);
  } catch (error) {
    if (error?.code === "TIMEOUT") return null;
    throw error;
  }
}

// Same nonce, ~12.5% more fee: nodes require a >=10% bump to replace a pending
// transaction, so 12.5% clears that floor with a small margin. Everything else
// (to, data, gas limit, nonce) is copied from the original so the replacement is
// the same claim, not a new one.
function bumpFee(value) { return value == null ? undefined : (BigInt(value) * 1125n) / 1000n; }
async function defaultRebroadcast(tx, contract) {
  const signer = contract.runner;
  if (!signer || typeof signer.sendTransaction !== "function") throw new Error("contract runner cannot sign a replacement");
  const request = { to: tx.to, data: tx.data, value: tx.value ?? 0n, nonce: tx.nonce, gasLimit: tx.gasLimit, chainId: tx.chainId };
  if (tx.maxFeePerGas != null) {
    request.maxFeePerGas = bumpFee(tx.maxFeePerGas);
    request.maxPriorityFeePerGas = bumpFee(tx.maxPriorityFeePerGas);
  } else if (tx.gasPrice != null) {
    request.gasPrice = bumpFee(tx.gasPrice);
  }
  return signer.sendTransaction(request);
}

// The claim-subject mapping is the only record of which Copus user a nullifier
// belongs to, and it must never trail the on-chain event. Ordering is strict:
//   1. registerClaim — synchronous, durable. If it fails the broadcast is
//      aborted, so an event can never exist without its mapping.
//   2. contract.claim.staticCall — pre-flight simulation. A proof the contract
//      would reject answers 409 and is never broadcast, so it never costs gas.
//      registerClaim has already happened by then; that is fine and intended:
//      the mapping is first-writer-wins and keyed by (campaign, nullifier), so a
//      row for a claim that never lands is harmless, and a later valid claim for
//      the same nullifier (same subject, by construction) simply reuses it.
//   3. contract.claim — the broadcast itself, serialized through the send queue.
//   4. attachClaimTx — best-effort bookkeeping only. A failure here must not
//      turn an already-broadcast claim into a client-facing error.
// Registrations are first-writer-wins: a nullifier binds to one subjectSecret,
// so a later request cannot hijack an existing subject mapping.
function createClaimHandler({
  contract, store, tokens,
  provider = contract?.runner?.provider,
  signerAddress,
  maxClaimsPerHour, minBalanceWei, confirmTimeoutMs, maxRebroadcasts,
  wait = defaultWait,
  rebroadcast = (tx) => defaultRebroadcast(tx, contract),
  now = Date.now,
  log = console,
}) {
  const env = optionsFromEnv();
  const limits = {
    maxClaimsPerHour: maxClaimsPerHour ?? env.maxClaimsPerHour,
    minBalanceWei: BigInt(minBalanceWei ?? env.minBalanceWei),
    confirmTimeoutMs: confirmTimeoutMs ?? env.confirmTimeoutMs,
    maxRebroadcasts: maxRebroadcasts ?? env.maxRebroadcasts,
  };
  const queue = createSendQueue();
  const budget = createHourlyBudget(limits.maxClaimsPerHour, now);
  const balance = createBalanceGuard({ provider, signerAddress, minBalanceWei: limits.minBalanceWei, now });
  const watchers = new Set();

  const record = (row) => {
    try { store.upsertClaimTx(row); } catch (error) { log.error(`claim_txs update failed for ${row.transactionHash}:`, error.message); }
  };

  // Receipt tracking. Runs after the 202 is already on the wire so the client
  // never waits for inclusion. Outcomes:
  //   receipt.status 1 -> 'confirmed'; 0 -> 'reverted' (no retry: the state that
  //   rejected it would reject the replacement too).
  //   no receipt within confirmTimeoutMs -> rebroadcast with the same nonce and a
  //   bumped fee, up to maxRebroadcasts; the superseded hash is marked 'dropped'
  //   pointing at its replacement; if every attempt times out the last hash stays
  //   'dropped'. A wait that reports the nonce was mined under a different hash
  //   (ethers TRANSACTION_REPLACED, e.g. the original landed after we replaced
  //   it) is settled from that receipt.
  async function watch({ tx, campaignId, nullifier }) {
    let current = tx;
    let attempts = 1;
    for (;;) {
      let receipt = null;
      try {
        receipt = await wait(current, limits.confirmTimeoutMs);
      } catch (error) {
        if (error?.receipt) {
          receipt = error.receipt;
        } else {
          record({ transactionHash: current.hash, campaignId, nullifier, status: "dropped", attempts, lastError: error.shortMessage || error.message });
          return;
        }
      }
      if (receipt) {
        const minedHash = receipt.hash || current.hash;
        const status = Number(receipt.status) === 1 ? "confirmed" : "reverted";
        if (minedHash.toLowerCase() !== current.hash.toLowerCase()) {
          record({ transactionHash: current.hash, campaignId, nullifier, status: "dropped", attempts, lastError: `replaced by ${minedHash}` });
        }
        record({ transactionHash: minedHash, campaignId, nullifier, status, attempts, lastError: status === "reverted" ? "reverted on-chain" : null });
        return;
      }
      if (attempts > limits.maxRebroadcasts) {
        record({ transactionHash: current.hash, campaignId, nullifier, status: "dropped", attempts, lastError: `no receipt after ${attempts} broadcast(s)` });
        return;
      }
      let replacement;
      try {
        replacement = await queue.run(() => rebroadcast(current));
      } catch (error) {
        record({ transactionHash: current.hash, campaignId, nullifier, status: "dropped", attempts, lastError: `rebroadcast failed: ${error.shortMessage || error.message}` });
        return;
      }
      record({ transactionHash: current.hash, campaignId, nullifier, status: "dropped", attempts, lastError: `replaced by ${replacement.hash}` });
      attempts += 1;
      record({ transactionHash: replacement.hash, campaignId, nullifier, status: "pending", attempts });
      try { store.attachClaimTx(campaignId, nullifier, replacement.hash); } catch (error) { log.error(`claim_subjects tx-hash update failed for ${nullifier}:`, error.message); }
      current = replacement;
    }
  }

  function track(entry) {
    record({ transactionHash: entry.tx.hash, campaignId: entry.campaignId, nullifier: entry.nullifier, status: "pending", attempts: 1 });
    const task = watch(entry).catch((error) => log.error(`claim watcher failed for ${entry.tx.hash}:`, error.message));
    watchers.add(task);
    task.finally(() => watchers.delete(task));
  }

  async function handle(request, response) {
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url === "/healthz") {
      return response.end(JSON.stringify({
        ok: true, queueDepth: queue.depth, watching: watchers.size, claimsLastHour: budget.used(),
        lastBalanceWei: balance.last === null ? null : balance.last.toString(),
      }));
    }
    if (!validBearer(request, tokens)) { response.statusCode = 404; return response.end('{"error":"not found"}'); }
    if (request.method === "GET" && /^\/claims\/0x[0-9a-zA-Z]{1,64}$/.test(request.url)) {
      const row = store.claimTx(request.url.slice("/claims/".length));
      if (!row) { response.statusCode = 404; return response.end('{"error":"unknown transaction"}'); }
      return response.end(JSON.stringify(row));
    }
    if (request.method !== "POST" || request.url !== "/claims") {
      response.statusCode = 404; return response.end('{"error":"not found"}');
    }
    try {
      const input = await readJson(request);
      if (!input.subjectRef || String(input.subjectRef).length > 128) throw new Error("subjectRef is required");
      // The proof is bound to this epoch; the contract decides whether it is currently claimable.
      const epoch = input.epoch === undefined ? 0n : BigInt(input.epoch);
      if (epoch < 0n) throw new Error("epoch must be a non-negative integer");
      const encodedProof = ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint256[2]", "uint256[2][2]", "uint256[2]"],
        [input.solidityProof.a, input.solidityProof.b, input.solidityProof.c]
      );
      const args = [input.campaignId, input.batchId, input.nullifier, input.ruleHash, epoch, encodedProof];
      // Cheap local/cached guards first, so an exhausted relayer answers without touching the chain.
      if (budget.exhausted()) throw new HttpError(429, "relayer hourly claim budget exhausted");
      await balance.check();
      store.registerClaim(input.campaignId, input.nullifier, input.subjectRef);
      try {
        await contract.claim.staticCall(...args);
      } catch (error) {
        if (isRevert(error)) throw new HttpError(409, revertReason(error));
        throw new HttpError(503, `simulation unavailable: ${error.shortMessage || error.message}`);
      }
      // reserve() is synchronous and runs in the same tick as queue.run(), so the
      // budget can never admit more broadcasts than it counted.
      budget.reserve();
      const tx = await queue.run(() => contract.claim(...args));
      try {
        store.attachClaimTx(input.campaignId, input.nullifier, tx.hash);
      } catch (error) {
        log.error(`claim_subjects tx-hash update failed for ${input.nullifier}:`, error.message);
      }
      response.statusCode = 202;
      response.end(JSON.stringify({ transactionHash: tx.hash }));
      track({ tx, campaignId: input.campaignId, nullifier: input.nullifier });
    } catch (error) {
      response.statusCode = error instanceof HttpError ? error.statusCode : 400;
      response.end(JSON.stringify({ error: error.shortMessage || error.message }));
    }
  }

  /** Resolves once every background receipt watcher started so far has finished (tests and graceful shutdown). */
  handle.drain = () => Promise.all([...watchers]);
  handle.stats = () => ({ queueDepth: queue.depth, watching: watchers.size, claimsLastHour: budget.used(), lastBalanceWei: balance.last });
  return handle;
}

async function main() {
  for (const key of ["RPC_URL", "CAMPAIGN_CONTRACT_ADDRESS", "RELAYER_PRIVATE_KEY"]) {
    if (!process.env[key]) throw new Error(`${key} is required`);
  }
  const tokens = parseBearerTokens(process.env.RELAYER_TOKENS, process.env.RELAYER_TOKEN);
  if (tokens.length === 0) throw new Error("RELAYER_TOKEN or RELAYER_TOKENS is required");
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const signer = new ethers.Wallet(process.env.RELAYER_PRIVATE_KEY, provider);
  const selected = Number(process.env.POE_VERSION) === 2 ? v2Artifact : artifact;
  const contract = new ethers.Contract(process.env.CAMPAIGN_CONTRACT_ADDRESS, selected.abi, signer);
  const store = new SqliteCheckpointStore(process.env.INDEXER_DB || require("path").join(process.cwd(), "poe-indexer.db"));
  const handler = createClaimHandler({ contract, store, tokens, provider, signerAddress: signer.address, ...optionsFromEnv() });
  const server = http.createServer(handler);
  server.listen(Number(process.env.PORT || 8788), process.env.BIND_HOST || "127.0.0.1");
}

module.exports = { createClaimHandler, createSendQueue, optionsFromEnv, revertReason };

if (require.main === module) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
