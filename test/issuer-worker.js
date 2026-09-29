const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { ethers } = require("ethers");
const { hashValues, fieldHex, TREE_DEPTH } = require("../lib/poe");
const { normalizePolicy, hashFunctions, policyHash } = require("../lib/poe-v2");
const { loadKey, decryptJson, ALG } = require("../lib/batch-crypto");
const {
  runIssuer, replayBatch, readBackendJson, createExportFetcher, createWriteBack, createCommitter, createArchiver, archiveFileName, parseArgs,
} = require("../services/issuer-worker");

const POLICY = { minEvents: "3", minDwellSeconds: "90", notBefore: "1700000000" };
const CHAIN_ID = 10143;
const KEY = crypto.randomBytes(32).toString("hex");

describe("PoE v2 issuer pages", function () {
  it("continues past empty candidate pages and commits the complete v2 rule hash", async function () {
    const policy = {
      version: 2, minEvents: "0", minDwellSeconds: "0", notBefore: "1700000000", match: "ALL",
      rules: [{ type: "brand_visit", operator: 3, threshold: "1", target: "77" }],
    };
    const seen = [];
    const committed = [];
    const result = await runIssuer({
      campaignId: 7,
      chainId: CHAIN_ID,
      fetchExport: async ({ cursor }) => cursor === undefined
        ? { campaignId: "7", policy, receipts: [], nextCursor: "256" }
        : { campaignId: "7", policy, receipts: [{ ...receiptRow(300), receipt: { ...receiptRow(300).receipt, facts: ["1"] } }], nextCursor: null },
      commit: async (entry) => { committed.push(entry); return { batchId: 17, transactionHash: `0x${"ab".repeat(32)}`, chainId: CHAIN_ID }; },
      writeBack: async (body) => seen.push(body),
      log: () => {},
    });
    const hash = await hashFunctions();
    expect(committed[0].policyHash).to.equal(fieldHex(policyHash(normalizePolicy(policy), hash)));
    expect(seen[0].entries[0].receipt.facts).to.deep.equal(["1"]);
    expect(result.exhausted).to.equal(true);
  });
});

function receiptRow(userId) {
  return {
    subjectRef: `copus-user:${userId}`,
    receipt: {
      subjectSecret: (123456789012345678901234567890n + BigInt(userId) * 7919n).toString(),
      eventCount: String(3 + (userId % 4)),
      totalDwellSeconds: String(100 + userId),
      observedAt: "1800000000",
      receiptNonce: (99999n + BigInt(userId)).toString(),
    },
  };
}

// A backend with `total` receipts, paged by user id like the real export.
function fakeBackend(total, { pageSize = 256, policy = POLICY, campaignId = "7" } = {}) {
  const calls = [];
  const fetchExport = async ({ campaignId: requested, limit, cursor }) => {
    calls.push({ campaignId: requested, limit, cursor });
    const start = cursor === undefined ? 1 : Number(cursor) + 1;
    const ids = [];
    for (let id = start; id <= total && ids.length < Math.min(limit, pageSize); id++) ids.push(id);
    const last = ids.length ? ids[ids.length - 1] : null;
    return { campaignId, policy, receipts: ids.map(receiptRow), nextCursor: last !== null && last < total ? String(last) : null };
  };
  return { fetchExport, calls };
}

function fakeCommit(start = 12) {
  const calls = [];
  let next = start;
  const commit = async ({ root, policyHash }) => {
    calls.push({ root, policyHash });
    const batchId = String(next++);
    return { batchId, transactionHash: `0xtx${batchId}`, chainId: CHAIN_ID };
  };
  return { commit, calls };
}

function fakeWriteBack(failures = 0) {
  const bodies = [];
  let attempts = 0;
  const writeBack = async (body) => {
    attempts++;
    if (attempts <= failures) throw new Error(`backend unavailable (${attempts})`);
    bodies.push(body);
  };
  return { writeBack, bodies, attempts: () => attempts };
}

const quiet = { log: () => {}, warn: () => {}, sleep: async () => {} };

async function foldPath(entry) {
  const receipt = entry.receipt;
  let node = await hashValues([receipt.subjectSecret, receipt.eventCount, receipt.totalDwellSeconds, receipt.observedAt, receipt.receiptNonce]);
  for (let i = 0; i < TREE_DEPTH; i++) {
    const sibling = BigInt(entry.pathElements[i]);
    node = entry.pathIndices[i] ? await hashValues([sibling, node]) : await hashValues([node, sibling]);
  }
  return node;
}

describe("issuer worker", function () {
  this.timeout(120_000);

  it("paginates the export until nextCursor is null and commits one batch per page", async function () {
    const backend = fakeBackend(5, { pageSize: 2 });
    const committer = fakeCommit();
    const sink = fakeWriteBack();
    const result = await runIssuer({ campaignId: "7", fetchExport: backend.fetchExport, commit: committer.commit, writeBack: sink.writeBack, ...quiet });
    expect(backend.calls.map((call) => call.cursor)).to.deep.equal([undefined, "2", "4"]);
    expect(backend.calls.every((call) => call.limit === 256 && call.campaignId === "7")).to.equal(true);
    expect(committer.calls).to.have.length(3);
    expect(sink.bodies.map((body) => body.size)).to.deep.equal([2, 2, 1]);
    expect(sink.bodies.map((body) => body.batchId)).to.deep.equal(["12", "13", "14"]);
    expect(result.exhausted).to.equal(true);
    expect(result.batches).to.have.length(3);
  });

  it("stops on an empty page without committing anything", async function () {
    const committer = fakeCommit();
    const sink = fakeWriteBack();
    const result = await runIssuer({
      campaignId: "7", fetchExport: async () => ({ campaignId: "7", policy: POLICY, receipts: [], nextCursor: null }),
      commit: committer.commit, writeBack: sink.writeBack, ...quiet,
    });
    expect(committer.calls).to.have.length(0);
    expect(result.batches).to.have.length(0);
    expect(result.exhausted).to.equal(true);
  });

  it("caps the number of batches per run and reports where to resume", async function () {
    const backend = fakeBackend(10, { pageSize: 2 });
    const committer = fakeCommit();
    const sink = fakeWriteBack();
    const result = await runIssuer({ campaignId: "7", fetchExport: backend.fetchExport, commit: committer.commit, writeBack: sink.writeBack, maxBatches: 2, ...quiet });
    expect(committer.calls).to.have.length(2);
    expect(result.exhausted).to.equal(false);
    expect(result.nextCursor).to.equal("4");
  });

  it("commits exactly Poseidon(minEvents, minDwellSeconds, notBefore) as the policyHash", async function () {
    const backend = fakeBackend(3);
    const committer = fakeCommit();
    const sink = fakeWriteBack();
    const result = await runIssuer({ campaignId: "7", fetchExport: backend.fetchExport, commit: committer.commit, writeBack: sink.writeBack, ...quiet });
    const expected = fieldHex(await hashValues([POLICY.minEvents, POLICY.minDwellSeconds, POLICY.notBefore]));
    expect(committer.calls[0].policyHash).to.equal(expected);
    expect(sink.bodies[0].ruleHash).to.equal(expected);
    expect(result.ruleHash).to.equal(expected);
    expect(committer.calls[0].root).to.equal(fieldHex(BigInt(sink.bodies[0].evidenceRoot)));
  });

  it("aborts when the export policy changes between pages", async function () {
    let call = 0;
    const fetchExport = async ({ cursor }) => {
      call++;
      const policy = call === 1 ? POLICY : { ...POLICY, minEvents: "4" };
      return { campaignId: "7", policy, receipts: [receiptRow(cursor ? 2 : 1)], nextCursor: cursor ? null : "1" };
    };
    const committer = fakeCommit();
    const sink = fakeWriteBack();
    let failure;
    try { await runIssuer({ campaignId: "7", fetchExport, commit: committer.commit, writeBack: sink.writeBack, ...quiet }); } catch (error) { failure = error; }
    expect(failure.message).to.include("policy changed");
    expect(committer.calls).to.have.length(1);
  });

  it("flows the batchId parsed from EvidenceCommitted into the write-back", async function () {
    const artifact = require("../artifacts/contracts/EvidenceRegistry.sol/EvidenceRegistry.json");
    const iface = new ethers.Interface(artifact.abi);
    const issuer = "0x1111111111111111111111111111111111111111";
    const submitted = [];
    const contract = {
      interface: iface,
      commitEvidence: async (root, policyHash) => {
        submitted.push({ root, policyHash });
        const encoded = iface.encodeEventLog("EvidenceCommitted", [42n, root, policyHash, issuer]);
        return {
          hash: "0xdeadbeef",
          wait: async (confirmations) => ({ status: 1, hash: "0xdeadbeef", confirmations, logs: [{ ...encoded, address: issuer }, { topics: ["0x00"], data: "0x" }] }),
        };
      },
    };
    const commit = createCommitter({ contract, confirmations: 2, chainId: CHAIN_ID });
    const backend = fakeBackend(2);
    const sink = fakeWriteBack();
    await runIssuer({ campaignId: "7", fetchExport: backend.fetchExport, commit, writeBack: sink.writeBack, ...quiet });
    expect(submitted).to.have.length(1);
    expect(sink.bodies[0].batchId).to.equal("42");
    expect(sink.bodies[0].transactionHash).to.equal("0xdeadbeef");
    expect(sink.bodies[0].chainId).to.equal(CHAIN_ID);
  });

  it("refuses a commit whose emitted root does not match what was submitted", async function () {
    const artifact = require("../artifacts/contracts/EvidenceRegistry.sol/EvidenceRegistry.json");
    const iface = new ethers.Interface(artifact.abi);
    const contract = {
      interface: iface,
      commitEvidence: async (_root, policyHash) => ({
        hash: "0x01",
        wait: async () => ({ status: 1, hash: "0x01", logs: [iface.encodeEventLog("EvidenceCommitted", [1n, fieldHex(5n), policyHash, "0x1111111111111111111111111111111111111111"])] }),
      }),
    };
    const commit = createCommitter({ contract, chainId: CHAIN_ID });
    let failure;
    try { await commit({ root: fieldHex(6n), policyHash: fieldHex(7n) }); } catch (error) { failure = error; }
    expect(failure.message).to.include("does not match");
  });

  it("retries the write-back with backoff, then fails loudly and processes no further batches", async function () {
    const backend = fakeBackend(4, { pageSize: 2 });
    const committer = fakeCommit();
    const sink = fakeWriteBack(Infinity);
    const sleeps = [];
    let failure;
    try {
      await runIssuer({ campaignId: "7", fetchExport: backend.fetchExport, commit: committer.commit, writeBack: sink.writeBack, log: () => {}, warn: () => {}, sleep: async (ms) => sleeps.push(ms) });
    } catch (error) { failure = error; }
    expect(failure, "run must reject").to.exist;
    expect(sink.attempts()).to.equal(3);
    expect(sleeps).to.deep.equal([500, 1000]);
    expect(committer.calls).to.have.length(1);
    expect(backend.calls).to.have.length(1);
    expect(failure.message).to.include("batch 12");
    expect(failure.message).to.include(`root ${BigInt(committer.calls[0].root).toString()}`);
    expect(failure.message).to.include("--replay");
    expect(failure.batch).to.deep.equal({ campaignId: "7", batchId: "12", root: BigInt(committer.calls[0].root).toString(), ruleHash: committer.calls[0].policyHash, size: 2, transactionHash: "0xtx12" });
  });

  it("recovers when the write-back succeeds on a later attempt", async function () {
    const backend = fakeBackend(2);
    const committer = fakeCommit();
    const sink = fakeWriteBack(2);
    const result = await runIssuer({ campaignId: "7", fetchExport: backend.fetchExport, commit: committer.commit, writeBack: sink.writeBack, ...quiet });
    expect(sink.attempts()).to.equal(3);
    expect(result.batches).to.have.length(1);
  });

  it("aborts before any write-back or archive when the commit fails", async function () {
    const backend = fakeBackend(3);
    const sink = fakeWriteBack();
    let archived = 0;
    let failure;
    try {
      await runIssuer({
        campaignId: "7", fetchExport: backend.fetchExport, writeBack: sink.writeBack, archive: async () => { archived++; },
        commit: async () => { throw new Error("nonce too low"); }, ...quiet,
      });
    } catch (error) { failure = error; }
    expect(failure.message).to.equal("nonce too low");
    expect(sink.bodies).to.have.length(0);
    expect(sink.attempts()).to.equal(0);
    expect(archived).to.equal(0);
  });

  it("gives every entry a path that resolves to the committed root", async function () {
    const backend = fakeBackend(5);
    const committer = fakeCommit();
    const sink = fakeWriteBack();
    await runIssuer({ campaignId: "7", fetchExport: backend.fetchExport, commit: committer.commit, writeBack: sink.writeBack, ...quiet });
    const body = sink.bodies[0];
    expect(body.entries).to.have.length(5);
    for (const entry of body.entries) {
      expect(entry.pathElements).to.have.length(TREE_DEPTH);
      expect(entry.pathIndices).to.have.length(TREE_DEPTH);
      expect(await foldPath(entry)).to.equal(BigInt(body.evidenceRoot));
    }
    expect(body.entries.map((entry) => entry.leafIndex)).to.deep.equal([0, 1, 2, 3, 4]);
    expect(body.entries.map((entry) => entry.subjectRef)).to.deep.equal([1, 2, 3, 4, 5].map((id) => `copus-user:${id}`));
  });

  it("never writes a subject secret or receipt to the console, even when the write-back fails", async function () {
    const backend = fakeBackend(3);
    const committer = fakeCommit();
    const sink = fakeWriteBack(Infinity);
    const captured = [];
    const original = { log: console.log, error: console.error, warn: console.warn, info: console.info };
    console.log = console.error = console.warn = console.info = (...args) => captured.push(args.map(String).join(" "));
    let failure;
    try {
      await runIssuer({ campaignId: "7", fetchExport: backend.fetchExport, commit: committer.commit, writeBack: sink.writeBack, sleep: async () => {} });
    } catch (error) { failure = error; } finally { Object.assign(console, original); }
    expect(failure).to.exist;
    expect(captured.length).to.be.greaterThan(0);
    const output = captured.join("\n");
    for (const id of [1, 2, 3]) {
      const receipt = receiptRow(id).receipt;
      expect(output).to.not.include(receipt.subjectSecret);
      expect(output).to.not.include(receipt.receiptNonce);
      expect(output).to.not.include(`copus-user:${id}`);
    }
    expect(output).to.not.include("pathElements");
    expect(output).to.not.include("subjectSecret");
    const line = JSON.parse(captured[0]);
    expect(Object.keys(line)).to.deep.equal(["campaignId", "batchId", "root", "ruleHash", "size", "transactionHash"]);
    expect(String(failure.message)).to.not.include(receiptRow(1).receipt.subjectSecret);
  });

  it("produces the exact write-back body shape the backend expects", async function () {
    const backend = fakeBackend(2);
    const committer = fakeCommit();
    const sink = fakeWriteBack();
    await runIssuer({ campaignId: "7", fetchExport: backend.fetchExport, commit: committer.commit, writeBack: sink.writeBack, ...quiet });
    const body = sink.bodies[0];
    expect(Object.keys(body)).to.deep.equal(["campaignId", "batchId", "chainId", "evidenceRoot", "ruleHash", "transactionHash", "size", "entries"]);
    expect(body.campaignId).to.equal("7");
    expect(body.batchId).to.equal("12");
    expect(body.chainId).to.equal(10143);
    expect(body.evidenceRoot).to.match(/^\d+$/);
    expect(body.ruleHash).to.match(/^0x[0-9a-f]{64}$/);
    expect(body.transactionHash).to.equal("0xtx12");
    expect(body.size).to.equal(2);
    for (const entry of body.entries) {
      expect(Object.keys(entry)).to.deep.equal(["subjectRef", "leafIndex", "receipt", "pathElements", "pathIndices"]);
      expect(entry.subjectRef).to.match(/^copus-user:\d+$/);
      expect(Number.isInteger(entry.leafIndex)).to.equal(true);
      expect(Object.keys(entry.receipt)).to.deep.equal(["subjectSecret", "eventCount", "totalDwellSeconds", "observedAt", "receiptNonce"]);
      for (const value of Object.values(entry.receipt)) expect(value).to.match(/^\d+$/);
      expect(entry.pathElements).to.have.length(8);
      for (const value of entry.pathElements) expect(value).to.match(/^\d+$/);
      expect(entry.pathIndices).to.have.length(8);
      for (const value of entry.pathIndices) expect([0, 1]).to.include(value);
    }
    // The body must survive JSON without losing precision: everything is a string, an int, or an array of those.
    expect(JSON.parse(JSON.stringify(body))).to.deep.equal(body);
  });

  it("rejects export rows without a subjectRef or with malformed numbers", async function () {
    const committer = fakeCommit();
    const sink = fakeWriteBack();
    for (const bad of [
      { subjectRef: null, receipt: receiptRow(1).receipt },
      { subjectRef: "copus-user:1", receipt: { ...receiptRow(1).receipt, eventCount: "3.5" } },
      { subjectRef: "copus-user:1", receipt: { ...receiptRow(1).receipt, subjectSecret: undefined } },
    ]) {
      let failure;
      try {
        await runIssuer({ campaignId: "7", fetchExport: async () => ({ policy: POLICY, receipts: [bad], nextCursor: null }), commit: committer.commit, writeBack: sink.writeBack, ...quiet });
      } catch (error) { failure = error; }
      expect(failure, JSON.stringify(Object.keys(bad))).to.exist;
    }
    expect(committer.calls).to.have.length(0);
  });

  describe("Copus backend HTTP adapters", function () {
    function jsonResponse(body, status = 200) {
      return { ok: status >= 200 && status < 300, status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) };
    }

    it("sends the export request with bearer auth, campaignId, limit and cursor", async function () {
      const requests = [];
      const page = { campaignId: "7", policy: POLICY, receipts: [receiptRow(1)], nextCursor: "1" };
      const fetchImpl = async (url, init) => { requests.push({ url: String(url), init }); return jsonResponse(page); };
      const fetchExport = createExportFetcher({ baseUrl: "http://backend.internal:8080/", token: "secret-token", fetchImpl });
      expect(await fetchExport({ campaignId: "7", limit: 256 })).to.deep.equal(page);
      expect(await fetchExport({ campaignId: "7", limit: 256, cursor: "42" })).to.deep.equal(page);
      expect(requests[0].url).to.equal("http://backend.internal:8080/evidence/export?campaignId=7&limit=256");
      expect(requests[1].url).to.equal("http://backend.internal:8080/evidence/export?campaignId=7&limit=256&cursor=42");
      expect(requests[0].init.method).to.equal("GET");
      expect(requests[0].init.headers.authorization).to.equal("Bearer secret-token");
    });

    it("POSTs the write-back body as JSON with bearer auth and throws on non-2xx", async function () {
      const requests = [];
      let status = 200;
      const fetchImpl = async (url, init) => { requests.push({ url: String(url), init }); return jsonResponse({ ok: true }, status); };
      const writeBack = createWriteBack({ baseUrl: "http://backend.internal:8080", token: "secret-token", fetchImpl });
      const body = { campaignId: "7", batchId: "12", chainId: CHAIN_ID, evidenceRoot: "1", ruleHash: "0x01", transactionHash: "0x02", size: 0, entries: [] };
      await writeBack(body);
      expect(requests[0].url).to.equal("http://backend.internal:8080/evidence/writeback");
      expect(requests[0].init.method).to.equal("POST");
      expect(requests[0].init.headers.authorization).to.equal("Bearer secret-token");
      expect(requests[0].init.headers["content-type"]).to.equal("application/json");
      expect(JSON.parse(requests[0].init.body)).to.deep.equal(body);
      status = 503;
      let failure;
      try { await writeBack(body); } catch (error) { failure = error; }
      expect(failure.message).to.include("HTTP 503");
    });

    it("unwraps the ResultTO envelope and treats status !== 1 as an error carrying msg", async function () {
      const page = { campaignId: "7", policy: POLICY, receipts: [], nextCursor: null };
      expect(await readBackendJson(jsonResponse({ status: 1, msg: "ok", data: page }), "x")).to.deep.equal(page);
      expect(await readBackendJson(jsonResponse(page), "x")).to.deep.equal(page);
      let failure;
      try { await readBackendJson(jsonResponse({ status: 403, msg: "bad token", data: null }), "receipt export"); } catch (error) { failure = error; }
      expect(failure.message).to.equal("receipt export failed: bad token");
      failure = undefined;
      try { await readBackendJson(jsonResponse({ status: 500, msg: "boom" }, 500), "receipt write-back"); } catch (error) { failure = error; }
      expect(failure.message).to.equal("receipt write-back failed: boom");
      failure = undefined;
      try { await readBackendJson(jsonResponse("<html>", 200), "x"); } catch (error) { failure = error; }
      expect(failure.message).to.include("non-JSON");
      // A full run through the fetcher with enveloped pages.
      const pages = [
        { status: 1, msg: "", data: { campaignId: "7", policy: POLICY, receipts: [receiptRow(1)], nextCursor: "1" } },
        { status: 1, msg: "", data: { campaignId: "7", policy: POLICY, receipts: [receiptRow(2)], nextCursor: null } },
      ];
      let i = 0;
      const fetchExport = createExportFetcher({ baseUrl: "http://b", token: "t", fetchImpl: async () => jsonResponse(pages[i++]) });
      const writeBack = createWriteBack({ baseUrl: "http://b", token: "t", fetchImpl: async () => jsonResponse({ status: 1, msg: "ok", data: { inserted: 1 } }) });
      const committer = fakeCommit();
      const result = await runIssuer({ campaignId: "7", fetchExport, commit: committer.commit, writeBack, ...quiet });
      expect(result.batches.map((batch) => batch.batchId)).to.deep.equal(["12", "13"]);
      const rejecting = createWriteBack({ baseUrl: "http://b", token: "t", fetchImpl: async () => jsonResponse({ status: 2, msg: "unknown campaign", data: null }) });
      failure = undefined;
      try { await rejecting({}); } catch (error) { failure = error; }
      expect(failure.message).to.equal("receipt write-back failed: unknown campaign");
    });
  });

  describe("archive and replay", function () {
    let dir;
    beforeEach(function () { dir = fs.mkdtempSync(path.join(os.tmpdir(), "poe-archive-")); });
    afterEach(function () { fs.rmSync(dir, { recursive: true, force: true }); });

    it("archives each batch as an owner-only AES-256-GCM envelope and never overwrites", async function () {
      const backend = fakeBackend(2);
      const committer = fakeCommit();
      const sink = fakeWriteBack();
      const archive = createArchiver({ dir, key: KEY });
      await runIssuer({ campaignId: "7", fetchExport: backend.fetchExport, commit: committer.commit, writeBack: sink.writeBack, archive, ...quiet });
      const file = path.join(dir, archiveFileName(CHAIN_ID, "12"));
      expect(path.basename(file)).to.equal("batch-10143-12.enc.json");
      expect(fs.statSync(file).mode & 0o777).to.equal(0o600);
      const envelope = JSON.parse(fs.readFileSync(file, "utf8"));
      expect(envelope.alg).to.equal(ALG);
      expect(fs.readFileSync(file, "utf8")).to.not.include("subjectSecret");
      expect(decryptJson(envelope, loadKey(KEY))).to.deep.equal(sink.bodies[0]);
      let failure;
      try { await archive(sink.bodies[0]); } catch (error) { failure = error; }
      expect(failure.code).to.equal("EEXIST");
    });

    it("replays a saved batch through the write-back only", async function () {
      const backend = fakeBackend(3);
      const committer = fakeCommit();
      const failing = fakeWriteBack(Infinity);
      const archive = createArchiver({ dir, key: KEY });
      try {
        await runIssuer({ campaignId: "7", fetchExport: backend.fetchExport, commit: committer.commit, writeBack: failing.writeBack, archive, ...quiet });
      } catch { /* expected: write-back failed after commit + archive */ }
      const file = path.join(dir, "batch-10143-12.enc.json");
      expect(fs.existsSync(file)).to.equal(true);
      const sink = fakeWriteBack();
      const replayCommit = fakeCommit();
      const summary = await replayBatch({ file, key: KEY, writeBack: sink.writeBack, ...quiet });
      expect(replayCommit.calls).to.have.length(0);
      expect(sink.bodies).to.have.length(1);
      expect(sink.bodies[0].batchId).to.equal("12");
      expect(sink.bodies[0].entries).to.have.length(3);
      expect(summary.batchId).to.equal("12");
      let failure;
      try { await replayBatch({ file, key: undefined, writeBack: sink.writeBack, ...quiet }); } catch (error) { failure = error; }
      expect(failure.message).to.include("BATCH_ENCRYPTION_KEY");
    });
  });

  it("parses CLI arguments", function () {
    expect(parseArgs(["--campaign", "7"])).to.deep.equal({ campaign: "7", replay: undefined });
    expect(parseArgs(["--campaign=9", "--replay=/x/batch.enc.json"])).to.deep.equal({ campaign: "9", replay: "/x/batch.enc.json" });
    expect(() => parseArgs(["--bogus"])).to.throw("unknown argument");
  });
});
