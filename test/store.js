const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { SqliteCheckpointStore } = require("../services/settlement-indexer");

describe("sqlite checkpoint store", function () {
  let dir, dbPath;
  beforeEach(function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "poe-store-"));
    dbPath = path.join(dir, "indexer.db");
  });
  afterEach(function () {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("keeps the database owner-only", function () {
    new SqliteCheckpointStore(dbPath);
    expect(fs.statSync(dbPath).mode & 0o777).to.equal(0o600);
  });

  it("resolves a registered claim subject case-insensitively", function () {
    const store = new SqliteCheckpointStore(dbPath);
    store.registerClaim("1", "0xAB", "copus-user:42");
    expect(store.claimSubject("1", "0xab")).to.equal("copus-user:42");
    expect(store.claimSubject("1", "0xcd")).to.equal(undefined);
  });

  it("is first-writer-wins: a duplicate registration cannot hijack the subject", function () {
    const store = new SqliteCheckpointStore(dbPath);
    store.registerClaim("1", "0x01", "copus-user:42");
    store.registerClaim("1", "0x01", "attacker:9");
    expect(store.claimSubject("1", "0x01")).to.equal("copus-user:42");
  });

  it("attaches the transaction hash without touching the subject", function () {
    const store = new SqliteCheckpointStore(dbPath);
    store.registerClaim("1", "0x01", "copus-user:42");
    store.attachClaimTx("1", "0x01", "0xtx");
    expect(store.claimSubject("1", "0x01")).to.equal("copus-user:42");
    const row = store.db.prepare("SELECT transaction_hash FROM claim_subjects WHERE campaign_id='1' AND nullifier='0x01'").get();
    expect(row.transaction_hash).to.equal("0xtx");
  });

  it("keeps the first-seen block origin across retries and retires voided keys from the retry queue", function () {
    const store = new SqliteCheckpointStore(dbPath);
    store.pending("10143:0xaa:0", { blockNumber: 15, blockHash: "0xB15" });
    store.failed("10143:0xaa:0", new Error("mapping missing"));
    store.pending("10143:0xbb:1"); // origin unknown, e.g. a legacy row
    store.failed("10143:0xbb:1", new Error("mapping missing"));
    expect(store.failedKeys(5)).to.deep.equal([
      { key: "10143:0xaa:0", blockNumber: 15, blockHash: "0xb15" },
      { key: "10143:0xbb:1", blockNumber: null, blockHash: null },
    ]);
    store.pending("10143:0xaa:0", { blockNumber: 99, blockHash: "0xother" }); // a retry must not rewrite where it was first seen
    expect(store.failedKeys(5)).to.deep.equal([{ key: "10143:0xbb:1", blockNumber: null, blockHash: null }]);
    store.failed("10143:0xaa:0", new Error("still missing"));
    expect(store.failedKeys(5).find((row) => row.key === "10143:0xaa:0")).to.include({ blockNumber: 15, blockHash: "0xb15" });
    expect(store.attempts("10143:0xaa:0")).to.equal(2);
    store.voided("10143:0xaa:0", "block 15 reorged");
    expect(store.failedKeys(5).map((row) => row.key)).to.deep.equal(["10143:0xbb:1"]);
    expect(store.voidedKeys(5)).to.deep.equal([{ key: "10143:0xaa:0", blockNumber: 15, blockHash: "0xb15" }]);
    store.rebaseOrigin("10143:0xaa:0", { blockNumber: 16, blockHash: "0xB16" });
    expect(store.voidedKeys(5)[0]).to.include({ blockNumber: 16, blockHash: "0xb16" });
    expect(store.completed("10143:0xaa:0")).to.equal(false);
    expect(store.db.prepare("SELECT status, last_error FROM settlements WHERE event_key='10143:0xaa:0'").get()).to.deep.equal({ status: "voided", last_error: "block 15 reorged" });
  });

  it("migrates a settlements table created before block origin columns existed", function () {
    const { DatabaseSync } = require("node:sqlite");
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`CREATE TABLE settlements (
      event_key TEXT PRIMARY KEY, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, updated_at TEXT NOT NULL
    ); INSERT INTO settlements VALUES ('10143:0xold:0','failed',1,'mapping missing','2026-01-01T00:00:00Z');`);
    legacy.close();
    const store = new SqliteCheckpointStore(dbPath);
    expect(store.failedKeys(5)).to.deep.equal([{ key: "10143:0xold:0", blockNumber: null, blockHash: null }]);
    store.pending("10143:0xold:0", { blockNumber: 7, blockHash: "0xb7" }); // a retry that can resolve the log fills the origin in
    store.failed("10143:0xold:0", new Error("still missing"));
    expect(store.failedKeys(5)).to.deep.equal([{ key: "10143:0xold:0", blockNumber: 7, blockHash: "0xb7" }]);
  });
});
