const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");

class SqliteCheckpointStore {
  constructor(filename) {
    this.db = new DatabaseSync(filename);
    // claim_subjects links Copus identities to on-chain nullifiers — the file
    // must stay owner-only. Best-effort: filesystems that ignore chmod (e.g.
    // some mounted volumes) simply keep their existing permissions.
    try { fs.chmodSync(filename, 0o600); } catch { /* non-POSIX filesystem */ }
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS indexer_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settlements (
        event_key TEXT PRIMARY KEY, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS claim_subjects (
        campaign_id TEXT NOT NULL, nullifier TEXT NOT NULL, subject_ref TEXT NOT NULL,
        transaction_hash TEXT, created_at TEXT NOT NULL,
        PRIMARY KEY(campaign_id, nullifier)
      );
      CREATE TABLE IF NOT EXISTS claim_txs (
        transaction_hash TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, nullifier TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','confirmed','reverted','dropped')),
        attempts INTEGER NOT NULL DEFAULT 1, last_error TEXT, updated_at TEXT NOT NULL
      );
    `);
    // Where the log was first seen. The retry pass compares block_hash against the chain
    // to tell a reorg (block replaced) from a lagging RPC (block unchanged, receipt missing).
    // Added after the table existed, so older databases are migrated in place.
    const columns = new Set(this.db.prepare("PRAGMA table_info(settlements)").all().map((row) => row.name));
    if (!columns.has("block_number")) this.db.exec("ALTER TABLE settlements ADD COLUMN block_number INTEGER");
    if (!columns.has("block_hash")) this.db.exec("ALTER TABLE settlements ADD COLUMN block_hash TEXT");
  }
  nextBlock(fallback) {
    const row = this.db.prepare("SELECT value FROM indexer_state WHERE key='next_block'").get();
    return row ? Number(row.value) : fallback;
  }
  saveNextBlock(block) {
    this.db.prepare("INSERT INTO indexer_state(key,value) VALUES('next_block',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(block));
  }
  completed(key) {
    return this.db.prepare("SELECT status FROM settlements WHERE event_key=?").get(key)?.status === "complete";
  }
  attempts(key) {
    return this.db.prepare("SELECT attempts FROM settlements WHERE event_key=?").get(key)?.attempts ?? 0;
  }
  /** Failed settlements that have not exhausted their retries, oldest first, with where each log was seen. */
  failedKeys(maxAttempts, limit = 50) {
    return this.db.prepare(`SELECT event_key key, block_number blockNumber, block_hash blockHash FROM settlements
      WHERE status='failed' AND attempts < ? ORDER BY updated_at LIMIT ?`).all(maxAttempts, limit);
  }
  /** Orphaned events are watched for re-inclusion under the same transaction hash. */
  voidedKeys(maxAttempts, limit = 50) {
    return this.db.prepare(`SELECT event_key key, block_number blockNumber, block_hash blockHash FROM settlements
      WHERE status='voided' AND attempts < ? ORDER BY updated_at LIMIT ?`).all(maxAttempts, limit);
  }
  touchVoided(key) {
    this.db.prepare("UPDATE settlements SET updated_at=? WHERE event_key=? AND status='voided'").run(new Date().toISOString(), key);
  }
  rebaseOrigin(key, origin) {
    this.db.prepare("UPDATE settlements SET block_number=?, block_hash=? WHERE event_key=?")
      .run(origin.blockNumber, String(origin.blockHash).toLowerCase(), key);
  }
  /** origin = { blockNumber, blockHash }; first sight is retained until a canonical retry re-mines the transaction. */
  pending(key, origin = {}) {
    this.db.prepare(`INSERT INTO settlements(event_key,status,attempts,block_number,block_hash,updated_at) VALUES(?,'pending',1,?,?,?)
      ON CONFLICT(event_key) DO UPDATE SET status='pending', attempts=attempts+1, updated_at=excluded.updated_at,
        block_number=COALESCE(settlements.block_number, excluded.block_number), block_hash=COALESCE(settlements.block_hash, excluded.block_hash)`)
      .run(key, origin.blockNumber ?? null, origin.blockHash == null ? null : String(origin.blockHash).toLowerCase(), new Date().toISOString());
  }
  complete(key) {
    this.db.prepare("UPDATE settlements SET status='complete',last_error=NULL,updated_at=? WHERE event_key=?").run(new Date().toISOString(), key);
  }
  failed(key, error) {
    this.db.prepare("UPDATE settlements SET status='failed',last_error=?,updated_at=? WHERE event_key=?").run(String(error).slice(0, 1000), new Date().toISOString(), key);
  }
  /** The original block is orphaned. No settlement attempts are spent while watching for re-inclusion. */
  voided(key, reason) {
    this.db.prepare("UPDATE settlements SET status='voided',last_error=?,updated_at=? WHERE event_key=?").run(String(reason).slice(0, 1000), new Date().toISOString(), key);
  }
  registerClaim(campaignId, nullifier, subjectRef) {
    // First-writer-wins on purpose: a nullifier derives from one subjectSecret,
    // so a duplicate registration must never rewrite an existing subject mapping.
    this.db.prepare(`INSERT INTO claim_subjects(campaign_id,nullifier,subject_ref,created_at)
      VALUES(?,?,?,?) ON CONFLICT(campaign_id,nullifier) DO NOTHING`)
      .run(String(campaignId), String(nullifier).toLowerCase(), String(subjectRef), new Date().toISOString());
  }
  attachClaimTx(campaignId, nullifier, transactionHash) {
    this.db.prepare("UPDATE claim_subjects SET transaction_hash=? WHERE campaign_id=? AND nullifier=?")
      .run(String(transactionHash), String(campaignId), String(nullifier).toLowerCase());
  }
  claimSubject(campaignId, nullifier) {
    return this.db.prepare("SELECT subject_ref subjectRef FROM claim_subjects WHERE campaign_id=? AND nullifier=?")
      .get(String(campaignId), String(nullifier).toLowerCase())?.subjectRef;
  }
  /**
   * One row per broadcast hash. A rebroadcast (same nonce, bumped fee) gets its own row
   * with attempts+1 and the superseded hash is marked 'dropped', so an operator can follow
   * the chain of replacements from any hash they were handed.
   */
  upsertClaimTx({ transactionHash, campaignId, nullifier, status = "pending", attempts = 1, lastError = null }) {
    this.db.prepare(`INSERT INTO claim_txs(transaction_hash,campaign_id,nullifier,status,attempts,last_error,updated_at)
      VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(transaction_hash) DO UPDATE SET status=excluded.status, attempts=excluded.attempts,
        last_error=excluded.last_error, updated_at=excluded.updated_at`)
      .run(String(transactionHash).toLowerCase(), String(campaignId), String(nullifier).toLowerCase(), status,
        Number(attempts), lastError == null ? null : String(lastError).slice(0, 1000), new Date().toISOString());
  }
  claimTx(transactionHash) {
    return this.db.prepare(`SELECT transaction_hash transactionHash, campaign_id campaignId, nullifier, status, attempts,
      last_error lastError, updated_at updatedAt FROM claim_txs WHERE transaction_hash=?`)
      .get(String(transactionHash).toLowerCase());
  }
  /** Broadcasts whose outcome is still unknown, oldest first (for an operator or a restart sweep). */
  pendingClaimTxs(limit = 100) {
    return this.db.prepare(`SELECT transaction_hash transactionHash, campaign_id campaignId, nullifier, status, attempts,
      last_error lastError, updated_at updatedAt FROM claim_txs WHERE status='pending' ORDER BY updated_at LIMIT ?`).all(limit);
  }
}

class SponsorshipSettlementIndexer {
  constructor({ provider, contract, store, settle, chainId, startBlock = 0, confirmations = 3, chunkSize = 1000, maxAttempts = 10 }) {
    Object.assign(this, { provider, contract, store, settle, chainId, startBlock, confirmations, chunkSize, maxAttempts });
  }

  /**
   * Settle one SponsorshipApproved log. Returns "processed", "failed" or "quarantined".
   * A log that exhausted maxAttempts stays 'failed' in the settlements table (dead letter)
   * and is never sent again.
   */
  async settleLog(log) {
    const key = `${this.chainId}:${log.transactionHash}:${log.index}`;
    if (this.store.completed(key)) return "skipped";
    if (typeof this.store.attempts === "function" && this.store.attempts(key) >= this.maxAttempts) return "quarantined";
    this.store.pending(key, { blockNumber: log.blockNumber, blockHash: log.blockHash });
    try {
      const campaign = await this.contract.campaigns(log.args.campaignId);
      const subjectRef = this.store.claimSubject(log.args.campaignId, log.args.nullifier);
      if (!subjectRef) throw new Error("claim subject mapping is missing");
      await this.settle({
        idempotencyKey: key,
        chainId: Number(this.chainId),
        transactionHash: log.transactionHash,
        logIndex: log.index,
        campaignId: log.args.campaignId.toString(),
        batchId: log.args.batchId.toString(),
        nullifier: log.args.nullifier,
        ruleHash: log.args.ruleHash,
        epoch: log.args.epoch === undefined ? "0" : log.args.epoch.toString(),
        subjectRef,
        timeSeconds: Number(campaign.timePerClaimMinutes) * 60,
      });
      this.store.complete(key);
      return "processed";
    } catch (error) {
      this.store.failed(key, error);
      return "failed";
    }
  }

  /**
   * A failed log whose receipt cannot be resolved right now is either behind a lagging RPC
   * node or in a block that was reorged away. Only the block hash tells them apart, so the
   * decision is made from it, never from a retry counter:
   *   block missing or hash unchanged -> transient; leave the row alone, no attempt spent
   *   hash changed                    -> original block orphaned; watch the same transaction
   *                                      hash because a re-mined transaction usually keeps it.
   * Rows without an origin (written before the columns existed) can only be retried.
   */
  async resolveUnresolvable(key, origin) {
    if (origin?.blockNumber == null || !origin.blockHash) return "unknown";
    const block = await this.provider.getBlock(origin.blockNumber);
    if (!block) return "lagging";
    return String(block.hash).toLowerCase() === String(origin.blockHash).toLowerCase() ? "lagging" : "reorged";
  }

  /**
   * The checkpoint deliberately advances past a failed event so one poisoned log can never
   * block later settlements. That means a failed event is never re-read by the block scan;
   * this pass re-fetches it from its receipt instead, so attempts actually climb and
   * maxAttempts quarantine is reachable. Without it "retry" is only a column in a table.
   */
  async retryFailed() {
    const counts = { processed: 0, failed: 0, quarantined: 0, voided: 0 };
    if (typeof this.store.failedKeys !== "function") return counts;
    const failed = this.store.failedKeys(this.maxAttempts);
    const voided = typeof this.store.voidedKeys === "function" ? this.store.voidedKeys(this.maxAttempts) : [];
    for (const row of [...failed, ...voided]) {
      const key = typeof row === "string" ? row : row.key;
      const origin = typeof row === "string" ? null : row;
      const wasVoided = voided.includes(row);
      const [, transactionHash, logIndex] = key.split(":");
      const receipt = await this.provider.getTransactionReceipt(transactionHash);
      const raw = receipt?.logs?.find((entry) => entry.index === Number(logIndex));
      let parsed = null;
      try { parsed = raw ? this.contract.interface.parseLog(raw) : null; } catch { /* unparseable */ }
      if (parsed && raw.blockNumber != null && raw.blockHash) {
        const block = await this.provider.getBlock(raw.blockNumber);
        if (!block || String(block.hash).toLowerCase() !== String(raw.blockHash).toLowerCase()) parsed = null;
      }
      if (!parsed) {
        if (wasVoided) {
          this.store.touchVoided?.(key); // rotate the watch queue so newer rows are also checked
        } else if (await this.resolveUnresolvable(key, origin) === "reorged" && typeof this.store.voided === "function") {
          this.store.voided(key, `block ${origin.blockNumber} ${origin.blockHash} is no longer canonical`);
          counts.voided++;
        }
        continue; // no settlement attempt was made
      }
      if (origin?.blockHash && raw.blockHash && String(origin.blockHash).toLowerCase() !== String(raw.blockHash).toLowerCase()) {
        this.store.rebaseOrigin?.(key, { blockNumber: raw.blockNumber, blockHash: raw.blockHash });
      }
      const outcome = await this.settleLog({ transactionHash, index: Number(logIndex), blockNumber: raw.blockNumber, blockHash: raw.blockHash, args: parsed.args });
      if (outcome in counts) counts[outcome]++;
    }
    return counts;
  }

  async tick() {
    const retried = await this.retryFailed();
    const safeHead = Math.max(0, (await this.provider.getBlockNumber()) - this.confirmations);
    const from = this.store.nextBlock(this.startBlock);
    if (from > safeHead) return { from, to: safeHead, ...retried };
    const to = Math.min(safeHead, from + this.chunkSize - 1);
    const logs = await this.contract.queryFilter(this.contract.filters.SponsorshipApproved(), from, to);
    const counts = { ...retried };
    for (const log of logs) {
      const outcome = await this.settleLog(log);
      if (outcome in counts) counts[outcome]++;
    }
    this.store.saveNextBlock(to + 1);
    return { from, to, ...counts };
  }
}

async function postSettlement(url, token, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "idempotency-key": payload.idempotencyKey },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`settlement returned HTTP ${response.status}`);
  return response.json();
}

module.exports = { SqliteCheckpointStore, SponsorshipSettlementIndexer, postSettlement };
