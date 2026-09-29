const { expect } = require("chai");
const { SponsorshipSettlementIndexer } = require("../services/settlement-indexer");

class MemoryStore {
  constructor() { this.next = undefined; this.done = new Set(); this.subjects = new Map(); this.attemptMap = new Map(); this.origins = new Map(); this.voidedMap = new Map(); }
  nextBlock(fallback) { return this.next ?? fallback; }
  saveNextBlock(value) { this.next = value; }
  completed(key) { return this.done.has(key); }
  attempts(key) { return this.attemptMap.get(key) ?? 0; }
  pending(key, origin) { this.attemptMap.set(key, this.attempts(key) + 1); if (origin && !this.origins.has(key)) this.origins.set(key, origin); this.failedSet?.delete(key); this.voidedMap.delete(key); }
  complete(key) { this.done.add(key); }
  failed(key) { this.failedSet = this.failedSet || new Set(); this.failedSet.add(key); }
  voided(key, reason) { this.voidedMap.set(key, reason); this.failedSet?.delete(key); }
  failedKeys(maxAttempts) {
    return [...(this.failedSet || [])].filter((key) => !this.done.has(key) && this.attempts(key) < maxAttempts)
      .map((key) => ({ key, ...(this.origins.get(key) || {}) }));
  }
  voidedKeys(maxAttempts) { return [...this.voidedMap.keys()].filter((key) => this.attempts(key) < maxAttempts).map((key) => ({ key, ...(this.origins.get(key) || {}) })); }
  rebaseOrigin(key, origin) { this.origins.set(key, origin); }
  registerClaim(campaignId, nullifier, subjectRef) { this.subjects.set(`${campaignId}:${nullifier}`, subjectRef); }
  attachClaimTx() {}
  claimSubject(campaignId, nullifier) { return this.subjects.get(`${campaignId}:${nullifier}`); }
}

function fixture(logs, store, extra = {}) {
  const chain = extra.chain || { blocks: {} }; // blockNumber -> canonical hash, for reorg detection
  const provider = {
    getBlockNumber: async () => 20,
    // The retry pass re-reads a failed event from its receipt rather than from a block scan.
    getTransactionReceipt: async (hash) => extra.receiptVisible === false ? null : ({ logs: logs.filter((log) => log.transactionHash === hash) }),
    getBlock: async (number) => (number in chain.blocks ? { number, hash: chain.blocks[number] } : null),
  };
  const contract = {
    filters: { SponsorshipApproved: () => ({}) },
    queryFilter: async (_, from, to) => logs.filter((log) => from <= log.block && log.block <= to),
    campaigns: async () => ({ timePerClaimMinutes: 30n }),
    interface: { parseLog: (log) => ({ args: log.args }) },
  };
  const indexer = new SponsorshipSettlementIndexer({
    provider, contract, store, chainId: 10143, startBlock: 15, confirmations: 5,
    settle: extra.settle || (async () => {}), ...extra,
  });
  return indexer;
}

describe("settlement indexer", function () {
  it("waits for confirmations and settles each log idempotently", async function () {
    const log = { block: 15, transactionHash: "0xabc", index: 2, args: { campaignId: 3n, batchId: 4n, nullifier: "0x01", ruleHash: "0x02" } };
    const store = new MemoryStore();
    store.registerClaim(3n, "0x01", "copus-user:42");
    const payloads = [];
    const indexer = fixture([log], store, { settle: async (payload) => payloads.push(payload) });
    expect((await indexer.tick()).processed).to.equal(1);
    expect(payloads[0].idempotencyKey).to.equal("10143:0xabc:2");
    expect(payloads[0].timeSeconds).to.equal(1800);
    expect(payloads[0].subjectRef).to.equal("copus-user:42");
    expect(payloads[0].epoch).to.equal("0"); // legacy logs without an epoch settle as epoch 0
    store.next = 15;
    expect((await indexer.tick()).processed).to.equal(0);
    expect(payloads).to.have.length(1);
  });

  it("skips a poisoned event instead of blocking later settlements", async function () {
    const bad = { block: 15, transactionHash: "0xbad", index: 0, args: { campaignId: 3n, batchId: 4n, nullifier: "0x0a", ruleHash: "0x02" } };
    const good = { block: 15, transactionHash: "0xabc", index: 2, args: { campaignId: 3n, batchId: 4n, nullifier: "0x01", ruleHash: "0x02" } };
    const store = new MemoryStore();
    store.registerClaim(3n, "0x01", "copus-user:42"); // bad log has no subject mapping
    const payloads = [];
    const indexer = fixture([bad, good], store, { settle: async (payload) => payloads.push(payload) });
    const tick = await indexer.tick();
    expect(tick.processed).to.equal(1);
    expect(tick.failed).to.equal(1);
    expect(payloads).to.have.length(1);
    expect(payloads[0].subjectRef).to.equal("copus-user:42");
    expect(store.next).to.equal(16); // checkpoint still advances past the poisoned event
  });

  it("retries a failed event on the next tick without a manual rewind, then settles it", async function () {
    const log = { block: 15, transactionHash: "0xretry", index: 1, args: { campaignId: 3n, batchId: 4n, nullifier: "0x0b", ruleHash: "0x02" } };
    const store = new MemoryStore(); // no subject mapping yet: the first tick fails
    const payloads = [];
    const indexer = fixture([log], store, { maxAttempts: 3, settle: async (payload) => payloads.push(payload) });
    const first = await indexer.tick();
    expect(first.failed).to.equal(1);
    expect(store.next).to.equal(16); // checkpoint moved on: the block scan will never see it again
    store.registerClaim(3n, "0x0b", "copus-user:7"); // the relayer's mapping arrives late
    const second = await indexer.tick(); // no rewind
    expect(second.processed).to.equal(1);
    expect(payloads).to.have.length(1);
    expect(payloads[0].subjectRef).to.equal("copus-user:7");
    expect(store.attempts("10143:0xretry:1")).to.equal(2);
    const third = await indexer.tick();
    expect(third.processed).to.equal(0); // completed: never sent twice
    expect(payloads).to.have.length(1);
  });

  it("stops retrying once maxAttempts is exhausted", async function () {
    const bad = { block: 15, transactionHash: "0xbad2", index: 0, args: { campaignId: 3n, batchId: 4n, nullifier: "0x0c", ruleHash: "0x02" } };
    const store = new MemoryStore();
    const calls = [];
    const indexer = fixture([bad], store, { maxAttempts: 2, settle: async (payload) => calls.push(payload) });
    expect((await indexer.tick()).failed).to.equal(1); // attempt 1 via block scan
    expect((await indexer.tick()).failed).to.equal(1); // attempt 2 via retry pass
    const third = await indexer.tick();                // exhausted: dead letter, not re-sent
    expect(third.failed).to.equal(0);
    expect(third.quarantined).to.equal(0); // it is no longer even offered for retry
    expect(store.attempts("10143:0xbad2:0")).to.equal(2);
    expect(calls).to.have.length(0);
  });

  it("voids a failed event whose block was reorged away, without spending an attempt", async function () {
    const log = { block: 15, blockNumber: 15, blockHash: "0xB15", transactionHash: "0xreorg", index: 0, args: { campaignId: 3n, batchId: 4n, nullifier: "0x0d", ruleHash: "0x02" } };
    const store = new MemoryStore();
    const calls = [];
    const chain = { blocks: { 15: "0xb15" } }; // canonical hash, case differs from the log's
    const indexer = fixture([log], store, { maxAttempts: 5, chain, settle: async (payload) => calls.push(payload) });
    expect((await indexer.tick()).failed).to.equal(1); // attempt 1: no subject mapping
    // Block 15 is replaced and the transaction is gone from it. The retry pass must
    // recognise the reorg from the block hash and retire the key for good.
    chain.blocks[15] = "0xdifferent";
    log.transactionHash = "0xremined-elsewhere";
    const second = await indexer.tick();
    expect(second.voided).to.equal(1);
    expect(second.failed).to.equal(0);
    expect(store.voidedMap.get("10143:0xreorg:0")).to.match(/no longer canonical/);
    expect(store.attempts("10143:0xreorg:0")).to.equal(1); // not a settlement attempt
    expect((await indexer.tick()).voided).to.equal(0); // watched without another settlement attempt
    expect(calls).to.have.length(0);
  });

  it("recovers a same-hash re-mined claim after a temporarily missing receipt", async function () {
    const log = { block: 15, blockNumber: 15, blockHash: "0xold", transactionHash: "0xremine", index: 0,
      args: { campaignId: 3n, batchId: 4n, nullifier: "0x0f", ruleHash: "0x02" } };
    const store = new MemoryStore();
    const chain = { blocks: { 15: "0xold", 16: "0xnew" } };
    const extra = { chain, maxAttempts: 5, receiptVisible: true, settle: async (payload) => calls.push(payload) };
    const calls = [];
    const indexer = fixture([log], store, extra);
    expect((await indexer.tick()).failed).to.equal(1);
    chain.blocks[15] = "0xreplacement";
    log.block = log.blockNumber = 16; log.blockHash = "0xnew";
    // The re-mined receipt resolves, but the subject mapping is still missing.
    expect((await indexer.tick()).failed).to.equal(1);
    expect(store.origins.get("10143:0xremine:0")).to.deep.equal({ blockNumber: 16, blockHash: "0xnew" });
    extra.receiptVisible = false;
    expect((await indexer.tick()).voided).to.equal(0); // the current block has not changed
    // A second reorg occurs while the receipt is unavailable. This must remain recoverable.
    chain.blocks[16] = "0xreplacement2";
    expect((await indexer.tick()).voided).to.equal(1);
    expect(store.attempts("10143:0xremine:0")).to.equal(2);
    log.block = log.blockNumber = 17; log.blockHash = "0xnewer"; chain.blocks[17] = "0xnewer";
    store.registerClaim(3n, "0x0f", "copus-user:10");
    extra.receiptVisible = true;
    expect((await indexer.tick()).processed).to.equal(1);
    expect(calls).to.have.length(1);
    expect(store.attempts("10143:0xremine:0")).to.equal(3);
  });

  it("does not settle a receipt from an orphaned block", async function () {
    const log = { block: 15, blockNumber: 15, blockHash: "0xold", transactionHash: "0xorphan", index: 0,
      args: { campaignId: 3n, batchId: 4n, nullifier: "0x10", ruleHash: "0x02" } };
    const store = new MemoryStore();
    const chain = { blocks: { 15: "0xold" } };
    const calls = [];
    const indexer = fixture([log], store, { chain, settle: async (payload) => calls.push(payload) });
    expect((await indexer.tick()).failed).to.equal(1);
    store.registerClaim(3n, "0x10", "copus-user:11");
    chain.blocks[15] = "0xreplacement"; // RPC still serves a stale receipt
    expect((await indexer.tick()).voided).to.equal(1);
    expect(calls).to.have.length(0);
    expect(store.attempts("10143:0xorphan:0")).to.equal(1);
  });

  it("does not spend an attempt when a lagging RPC cannot yet serve the receipt", async function () {
    const log = { block: 15, blockNumber: 15, blockHash: "0xb15", transactionHash: "0xlag", index: 0, args: { campaignId: 3n, batchId: 4n, nullifier: "0x0e", ruleHash: "0x02" } };
    const store = new MemoryStore();
    const payloads = [];
    const chain = { blocks: { 15: "0xb15" } };
    const indexer = fixture([log], store, { maxAttempts: 2, chain, settle: async (payload) => payloads.push(payload) });
    expect((await indexer.tick()).failed).to.equal(1); // attempt 1: no subject mapping
    // A load-balanced node answers with no receipt while the block itself is unchanged.
    const original = log.transactionHash;
    log.transactionHash = "0xhidden";
    let tick = await indexer.tick();
    expect(tick.failed).to.equal(0); expect(tick.voided).to.equal(0);
    expect(store.attempts("10143:0xlag:0")).to.equal(1); // still one attempt
    // Same when the node is behind the block height entirely.
    delete chain.blocks[15];
    tick = await indexer.tick();
    expect(store.attempts("10143:0xlag:0")).to.equal(1);
    // Once the receipt is visible again and the mapping has arrived, it settles normally.
    chain.blocks[15] = "0xb15";
    log.transactionHash = original;
    store.registerClaim(3n, "0x0e", "copus-user:9");
    expect((await indexer.tick()).processed).to.equal(1);
    expect(payloads[0].subjectRef).to.equal("copus-user:9");
    expect(store.attempts("10143:0xlag:0")).to.equal(2);
  });

  it("quarantines events that exhaust maxAttempts", async function () {
    const bad = { block: 15, transactionHash: "0xbad", index: 0, args: { campaignId: 3n, batchId: 4n, nullifier: "0x0a", ruleHash: "0x02" } };
    const store = new MemoryStore();
    const calls = [];
    const indexer = fixture([bad], store, { maxAttempts: 1, settle: async (payload) => calls.push(payload) });
    const first = await indexer.tick();
    expect(first.failed).to.equal(1);
    store.next = 15; // rewind to face the same event again
    const second = await indexer.tick();
    expect(second.processed).to.equal(0);
    expect(second.quarantined).to.equal(1);
    expect(calls).to.have.length(0);
    expect(store.next).to.equal(16);
  });
});
