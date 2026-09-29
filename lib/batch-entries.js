const { buildBatch, jsonFields } = require("./poe");
const { buildBatchV2 } = require("./poe-v2");

// Input rows may be bare receipts or { "subjectRef": "...", "receipt": {...} }
// envelopes. subjectRef is distribution metadata: it is never hashed into a
// leaf, but it is how the issuer API and the Copus evidence store later find
// the right user's entry.
function normalizeEntries(rows) {
  if (!Array.isArray(rows)) throw new Error("receipts must be an array");
  return rows.map((row) => {
    if (row && typeof row === "object" && row.receipt && typeof row.receipt === "object") {
      return { subjectRef: row.subjectRef ?? null, receipt: row.receipt };
    }
    const { subjectRef = null, ...receipt } = row;
    return { subjectRef, receipt };
  });
}

// Builds the Merkle tree for a page of receipts and pairs every entry with its
// leaf index and path. Field elements come back as decimal strings so the
// result is JSON-safe and BigInt-exact.
async function buildBatchEntries(entries, policy) {
  const batch = Number(policy?.version) === 2
    ? await buildBatchV2(entries.map((entry) => entry.receipt), policy)
    : await buildBatch(entries.map((entry) => entry.receipt));
  return {
    batch,
    entries: entries.map((entry, index) => ({
      subjectRef: entry.subjectRef,
      leafIndex: index,
      receipt: jsonFields(entry.receipt),
      ...jsonFields(batch.proof(index)),
    })),
  };
}

module.exports = { normalizeEntries, buildBatchEntries };
