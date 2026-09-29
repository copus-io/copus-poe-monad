const { buildPoseidon } = require("circomlibjs");

const TREE_DEPTH = 8;
const MAX_LEAVES = 1 << TREE_DEPTH;
const FIELD_PRIME = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const U64 = 1n << 64n;
const COMPARED_FIELDS = ["eventCount", "totalDwellSeconds", "observedAt", "minEvents", "minDwellSeconds", "notBefore"];

async function hasher() {
  const poseidon = await buildPoseidon();
  return (values) => BigInt(poseidon.F.toString(poseidon(values.map(BigInt))));
}

async function hashValues(values) {
  const hash = await hasher();
  return hash(values);
}

function checkField(name, value, max) {
  const v = BigInt(value);
  if (v < 0n || v >= max) throw new Error(`${name}=${v} out of range`);
  return v;
}

// The circuit's GreaterEqThan(64) comparators are only sound for inputs below
// 2^64; every hashed value must also fit the BN254 scalar field. Neither is
// enforced inside the circuit, so reject out-of-domain values here.
function checkRanges(source) {
  for (const name of ["subjectSecret", "eventCount", "totalDwellSeconds", "observedAt", "receiptNonce",
                      "minEvents", "minDwellSeconds", "notBefore"]) {
    if (source[name] === undefined || source[name] === null) continue;
    checkField(name, source[name], COMPARED_FIELDS.includes(name) ? U64 : FIELD_PRIME);
  }
}

function receiptValues(receipt) {
  return [receipt.subjectSecret, receipt.eventCount, receipt.totalDwellSeconds, receipt.observedAt, receipt.receiptNonce];
}

async function buildBatch(receipts) {
  if (!Array.isArray(receipts) || receipts.length === 0 || receipts.length > MAX_LEAVES) {
    throw new Error(`receipts must contain 1-${MAX_LEAVES} items`);
  }
  receipts.forEach(checkRanges);
  const hash = await hasher();
  const leaves = receipts.map((receipt) => hash(receiptValues(receipt)));
  const levels = [Array(MAX_LEAVES).fill(0n)];
  leaves.forEach((leaf, index) => { levels[0][index] = leaf; });
  for (let depth = 0; depth < TREE_DEPTH; depth++) {
    const next = [];
    for (let i = 0; i < levels[depth].length; i += 2) next.push(hash([levels[depth][i], levels[depth][i + 1]]));
    levels.push(next);
  }
  return {
    root: levels[TREE_DEPTH][0], leaves,
    proof(index) {
      if (!Number.isInteger(index) || index < 0 || index >= receipts.length) throw new Error("invalid receipt index");
      const pathElements = [];
      const pathIndices = [];
      let cursor = index;
      for (let depth = 0; depth < TREE_DEPTH; depth++) {
        pathElements.push(levels[depth][cursor ^ 1]);
        pathIndices.push(cursor & 1);
        cursor >>= 1;
      }
      return { pathElements, pathIndices };
    },
  };
}

/**
 * Epoch a claim is bound to. A campaign with claimPeriodSeconds = 0 allows one
 * claim per subject for its whole lifetime, so its only epoch is 0. Otherwise the
 * epoch is floor(now / period): one claim per subject per period. The contract
 * accepts the current epoch and the one before it, and nothing earlier than the
 * campaign start.
 */
function claimEpoch(timestampSeconds, claimPeriodSeconds) {
  const period = BigInt(claimPeriodSeconds);
  return period === 0n ? 0n : BigInt(timestampSeconds) / period;
}

async function buildWitness(receipt, policy, campaignId, root, merkleProof, epoch = 0n) {
  checkRanges(receipt);
  checkRanges(policy);
  checkField("campaignId", campaignId, FIELD_PRIME);
  checkField("root", root, FIELD_PRIME);
  checkField("epoch", epoch, FIELD_PRIME);
  const hash = await hasher();
  return {
    evidenceRoot: BigInt(root),
    ruleHash: hash([policy.minEvents, policy.minDwellSeconds, policy.notBefore]),
    nullifier: hash([receipt.subjectSecret, campaignId, epoch]),
    campaignId: BigInt(campaignId),
    epoch: BigInt(epoch),
    ...Object.fromEntries(Object.entries(receipt).map(([key, value]) => [key, BigInt(value)])),
    ...Object.fromEntries(Object.entries(policy).map(([key, value]) => [key, BigInt(value)])),
    pathElements: merkleProof.pathElements.map(BigInt),
    pathIndices: merkleProof.pathIndices.map(Number),
  };
}

async function buildEvidence(receipt, policy, campaignId, epoch = 0n) {
  const batch = await buildBatch([receipt]);
  return buildWitness(receipt, policy, campaignId, batch.root, batch.proof(0), epoch);
}

function jsonFields(value) {
  return JSON.parse(JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item));
}

function fieldHex(value) {
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
}

module.exports = { TREE_DEPTH, MAX_LEAVES, FIELD_PRIME, U64, hashValues, checkRanges, claimEpoch, buildBatch, buildWitness, buildEvidence, jsonFields, fieldHex };
