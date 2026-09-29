const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Readable } = require("stream");
const { createClaimHandler, createSendQueue, optionsFromEnv, revertReason } = require("../services/relayer");
const { SqliteCheckpointStore } = require("../services/settlement-indexer");
const { parseBearerTokens, validBearer } = require("../services/bearer");

const TOKENS = ["old-token", "new-token"];
const BODY = {
  campaignId: "1",
  batchId: "1",
  nullifier: "0x01",
  ruleHash: "0x02",
  subjectRef: "copus-user:42",
  solidityProof: { a: ["1", "2"], b: [["1", "2"], ["3", "4"]], c: ["5", "6"] },
};
const quiet = { error() {} };

function invoke(handler, { method = "POST", url = "/claims", token, body = BODY } = {}) {
  const request = Readable.from(body ? [JSON.stringify(body)] : []);
  request.method = method;
  request.url = url;
  request.headers = token ? { authorization: `Bearer ${token}` } : {};
  return new Promise((resolve, reject) => {
    const response = {
      statusCode: 200,
      setHeader() {},
      end(chunk) { this.body = chunk; resolve(this); },
    };
    handler(request, response).catch(reject);
  });
}

/** A contract mock whose claim() has the staticCall companion ethers gives every method. */
function mockContract(calls, { simulate, send } = {}) {
  const claim = async (...args) => {
    calls.push("broadcast");
    return send ? send(...args) : { hash: "0xtx" };
  };
  claim.staticCall = async (...args) => { calls.push("simulate"); if (simulate) await simulate(...args); };
  return { claim };
}

function fixture(store = {}, options = {}, contractOptions = {}) {
  const calls = [];
  const contract = mockContract(calls, contractOptions);
  const full = {
    registerClaim: () => calls.push("register"),
    attachClaimTx: () => calls.push("attach"),
    upsertClaimTx: () => {},
    claimTx: () => undefined,
    ...store,
  };
  // wait resolves immediately so the fixture never leaves a watcher hanging on a fake tx.
  const handler = createClaimHandler({ contract, store: full, tokens: TOKENS, log: quiet, wait: async () => ({ status: 1 }), ...options });
  return { handler, calls, contract };
}

describe("relayer claim handler", function () {
  it("accepts any active token and rejects missing or wrong credentials", async function () {
    const { handler } = fixture();
    expect((await invoke(handler, { token: "new-token" })).statusCode).to.equal(202);
    expect((await invoke(handler, { token: "old-token" })).statusCode).to.equal(202);
    expect((await invoke(handler, { token: "wrong" })).statusCode).to.equal(404);
    expect((await invoke(handler, {})).statusCode).to.equal(404);
  });

  it("never broadcasts when the subject mapping cannot be persisted", async function () {
    const { handler, calls } = fixture({ registerClaim: () => { throw new Error("db locked"); } });
    const response = await invoke(handler, { token: "new-token" });
    expect(response.statusCode).to.equal(400);
    expect(calls).to.not.include("broadcast");
  });

  it("registers, simulates, then broadcasts, and still answers 202 when the tx-hash update fails", async function () {
    const { handler, calls } = fixture({ attachClaimTx: () => { throw new Error("db locked"); } });
    const response = await invoke(handler, { token: "new-token" });
    expect(response.statusCode).to.equal(202);
    expect(JSON.parse(response.body).transactionHash).to.equal("0xtx");
    expect(calls.slice(0, 3)).to.deep.equal(["register", "simulate", "broadcast"]);
  });
});

describe("relayer nonce serialization", function () {
  it("gives two concurrent requests distinct nonces because sends are queued", async function () {
    // Models a node: the pending nonce is read at send start and only advances once
    // the send completes. Unserialized sends would both read 0.
    let pendingNonce = 0;
    const nonces = [];
    const send = async () => {
      const nonce = pendingNonce;
      await new Promise((resolve) => setImmediate(resolve));
      pendingNonce = nonce + 1;
      nonces.push(nonce);
      return { hash: `0x${nonce}`, nonce };
    };
    const { handler } = fixture({}, {}, { send });
    const [a, b] = await Promise.all([invoke(handler, { token: "new-token" }), invoke(handler, { token: "new-token" })]);
    expect(a.statusCode).to.equal(202);
    expect(b.statusCode).to.equal(202);
    expect(nonces).to.deep.equal([0, 1]);
    expect(new Set([JSON.parse(a.body).transactionHash, JSON.parse(b.body).transactionHash]).size).to.equal(2);
  });

  it("keeps serving after a failed send and reports queue depth", async function () {
    const queue = createSendQueue();
    const order = [];
    const failed = queue.run(async () => { order.push("a"); throw new Error("underpriced"); });
    const second = queue.run(async () => { order.push("b"); return "ok"; });
    expect(queue.depth).to.equal(2);
    expect(await failed.then(() => "resolved", (error) => error.message)).to.equal("underpriced");
    expect(await second).to.equal("ok");
    expect(order).to.deep.equal(["a", "b"]);
    expect(queue.depth).to.equal(0);
  });
});

describe("relayer pre-flight simulation", function () {
  it("answers 409 with the custom error name and never broadcasts", async function () {
    const error = Object.assign(new Error("execution reverted (unknown custom error)"), { code: "CALL_EXCEPTION", revert: { name: "AlreadyClaimed" } });
    const { handler, calls } = fixture({}, {}, { simulate: async () => { throw error; } });
    const response = await invoke(handler, { token: "new-token" });
    expect(response.statusCode).to.equal(409);
    expect(JSON.parse(response.body)).to.deep.equal({ error: "AlreadyClaimed" });
    // registerClaim already ran: acceptable, the mapping is first-writer-wins and inert without an event.
    expect(calls).to.deep.equal(["register", "simulate"]);
  });

  it("maps every claim() custom error by name and falls back to the short message", function () {
    for (const name of ["AlreadyClaimed", "EpochMismatch", "RuleMismatch", "CampaignFull", "CampaignClosed", "CampaignNotStarted", "InvalidProof"]) {
      expect(revertReason({ errorName: name })).to.equal(name);
      expect(revertReason({ reason: name })).to.equal(name);
    }
    expect(revertReason({ shortMessage: "execution reverted: nope", message: "long" })).to.equal("execution reverted: nope");
    expect(revertReason({ message: "long" })).to.equal("long");
  });

  it("answers 503, not 409, when the simulation itself is unavailable", async function () {
    const { handler, calls } = fixture({}, {}, { simulate: async () => { throw new Error("socket hang up"); } });
    const response = await invoke(handler, { token: "new-token" });
    expect(response.statusCode).to.equal(503);
    expect(JSON.parse(response.body).error).to.match(/simulation unavailable/);
    expect(calls).to.not.include("broadcast");
  });
});

describe("relayer spend guards", function () {
  it("caps broadcasts per sliding hour with 429 and reopens once the window moves", async function () {
    let clock = 1_000_000;
    const { handler, calls } = fixture({}, { maxClaimsPerHour: 2, now: () => clock });
    expect((await invoke(handler, { token: "new-token" })).statusCode).to.equal(202);
    expect((await invoke(handler, { token: "new-token" })).statusCode).to.equal(202);
    const denied = await invoke(handler, { token: "new-token" });
    expect(denied.statusCode).to.equal(429);
    expect(JSON.parse(denied.body)).to.deep.equal({ error: "relayer hourly claim budget exhausted" });
    expect(calls.filter((call) => call === "broadcast")).to.have.length(2);
    clock += 60 * 60 * 1000 + 1;
    expect((await invoke(handler, { token: "new-token" })).statusCode).to.equal(202);
    expect(calls.filter((call) => call === "broadcast")).to.have.length(3);
  });

  it("refuses with 503 when the wallet is below reserve and caches the balance for 30 s", async function () {
    let clock = 5_000_000;
    let balance = 5n;
    let reads = 0;
    const provider = { getBalance: async () => { reads += 1; return balance; } };
    const { handler, calls } = fixture({}, { provider, signerAddress: "0xrelayer", minBalanceWei: 10n, now: () => clock });
    const denied = await invoke(handler, { token: "new-token" });
    expect(denied.statusCode).to.equal(503);
    expect(JSON.parse(denied.body)).to.deep.equal({ error: "relayer wallet balance below reserve" });
    expect(calls).to.not.include("broadcast");
    balance = 100n;
    expect((await invoke(handler, { token: "new-token" })).statusCode).to.equal(503); // cached low balance
    expect(reads).to.equal(1);
    clock += 30_000;
    expect((await invoke(handler, { token: "new-token" })).statusCode).to.equal(202);
    expect(reads).to.equal(2);
    const health = JSON.parse((await invoke(handler, { method: "GET", url: "/healthz", body: null })).body);
    expect(health).to.include({ ok: true, queueDepth: 0, lastBalanceWei: "100" });
    expect(health.claimsLastHour).to.equal(1);
  });

  it("reads guard settings from the environment", function () {
    const env = { RELAYER_MAX_CLAIMS_PER_HOUR: "7", RELAYER_MIN_BALANCE_WEI: "1000000000000000000", RELAYER_CONFIRM_TIMEOUT_MS: "5000", RELAYER_MAX_REBROADCASTS: "1" };
    expect(optionsFromEnv(env)).to.deep.equal({ maxClaimsPerHour: 7, minBalanceWei: 10n ** 18n, confirmTimeoutMs: 5000, maxRebroadcasts: 1 });
    expect(optionsFromEnv({})).to.deep.equal({ maxClaimsPerHour: 600, minBalanceWei: 0n, confirmTimeoutMs: 120_000, maxRebroadcasts: 2 });
  });
});

describe("relayer receipt tracking", function () {
  let dir, store;
  beforeEach(function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "poe-relayer-"));
    store = new SqliteCheckpointStore(path.join(dir, "indexer.db"));
  });
  afterEach(function () {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function tracked({ waits, rebroadcasts = [] }) {
    const calls = [];
    let broadcastCount = 0;
    const contract = mockContract(calls, { send: async () => ({ hash: `0xtx${++broadcastCount}`, nonce: 7 }) });
    const waited = [];
    const replaced = [];
    const handler = createClaimHandler({
      contract, store, tokens: TOKENS, log: quiet, confirmTimeoutMs: 1, maxRebroadcasts: 2,
      wait: async (tx) => { waited.push(tx.hash); const next = waits.shift(); if (next instanceof Error) throw next; return next; },
      rebroadcast: async (tx) => { replaced.push(tx.hash); return { hash: rebroadcasts.shift() || `0xre${replaced.length}`, nonce: tx.nonce }; },
    });
    return { handler, calls, waited, replaced };
  }

  it("records confirmed and serves it from GET /claims/<hash>", async function () {
    const { handler, waited } = tracked({ waits: [{ hash: "0xtx1", status: 1 }] });
    const accepted = await invoke(handler, { token: "new-token" });
    expect(accepted.statusCode).to.equal(202);
    await handler.drain();
    expect(waited).to.deep.equal(["0xtx1"]);
    const row = store.claimTx("0xtx1");
    expect(row).to.include({ campaignId: "1", nullifier: "0x01", status: "confirmed", attempts: 1, lastError: null });
    const fetched = await invoke(handler, { method: "GET", url: "/claims/0xtx1", token: "old-token", body: null });
    expect(fetched.statusCode).to.equal(200);
    expect(JSON.parse(fetched.body)).to.include({ transactionHash: "0xtx1", status: "confirmed" });
    expect((await invoke(handler, { method: "GET", url: "/claims/0xdead", token: "old-token", body: null })).statusCode).to.equal(404);
    expect((await invoke(handler, { method: "GET", url: "/claims/0xtx1", body: null })).statusCode).to.equal(404);
  });

  it("rebroadcasts exactly once after a timed-out wait and then records confirmed", async function () {
    const { handler, waited, replaced } = tracked({ waits: [null, { hash: "0xtx2", status: 1 }], rebroadcasts: ["0xtx2"] });
    await invoke(handler, { token: "new-token" });
    await handler.drain();
    expect(replaced).to.deep.equal(["0xtx1"]);
    expect(waited).to.deep.equal(["0xtx1", "0xtx2"]);
    expect(store.claimTx("0xtx1")).to.include({ status: "dropped", attempts: 1, lastError: "replaced by 0xtx2" });
    expect(store.claimTx("0xtx2")).to.include({ status: "confirmed", attempts: 2 });
    // The subject mapping follows the hash that will actually carry the event.
    expect(store.db.prepare("SELECT transaction_hash h FROM claim_subjects WHERE campaign_id='1' AND nullifier='0x01'").get().h).to.equal("0xtx2");
  });

  it("records reverted without rebroadcasting", async function () {
    const revert = Object.assign(new Error("transaction execution reverted"), { code: "CALL_EXCEPTION", receipt: { hash: "0xtx1", status: 0 } });
    const { handler, replaced } = tracked({ waits: [revert] });
    await invoke(handler, { token: "new-token" });
    await handler.drain();
    expect(replaced).to.deep.equal([]);
    expect(store.claimTx("0xtx1")).to.include({ status: "reverted", attempts: 1, lastError: "reverted on-chain" });
  });

  it("gives up as dropped once the rebroadcast budget is spent", async function () {
    const { handler, replaced } = tracked({ waits: [null, null, null], rebroadcasts: ["0xtx2", "0xtx3"] });
    await invoke(handler, { token: "new-token" });
    await handler.drain();
    expect(replaced).to.deep.equal(["0xtx1", "0xtx2"]);
    expect(store.claimTx("0xtx1").status).to.equal("dropped");
    expect(store.claimTx("0xtx2").status).to.equal("dropped");
    expect(store.claimTx("0xtx3")).to.include({ status: "dropped", attempts: 3, lastError: "no receipt after 3 broadcast(s)" });
  });

  it("settles from the receipt when the nonce was mined under the original hash after a replacement", async function () {
    const replacedError = Object.assign(new Error("transaction was replaced"), { code: "TRANSACTION_REPLACED", receipt: { hash: "0xtx1", status: 1 } });
    const { handler } = tracked({ waits: [null, replacedError], rebroadcasts: ["0xtx2"] });
    await invoke(handler, { token: "new-token" });
    await handler.drain();
    expect(store.claimTx("0xtx1")).to.include({ status: "confirmed" });
    expect(store.claimTx("0xtx2")).to.include({ status: "dropped", lastError: "replaced by 0xtx1" });
  });
});

describe("bearer token helpers", function () {
  it("parses comma-separated token lists for rotation", function () {
    expect(parseBearerTokens(" a , b ", undefined, "c")).to.deep.equal(["a", "b", "c"]);
    expect(parseBearerTokens()).to.deep.equal([]);
  });
});
