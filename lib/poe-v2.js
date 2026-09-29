const { buildPoseidon } = require("circomlibjs");
const { TREE_DEPTH, MAX_LEAVES, FIELD_PRIME, U64, fieldHex } = require("./poe");

const RULE_SLOTS = 12;
const OP = Object.freeze({ GE: 1, LE: 2, EQ: 3 });
const RULE = Object.freeze({
  active_days: 1,
  work_count: 2,
  comment_count: 3,
  space_count: 4,
  time_spent: 5,
  followers: 6,
  space_membership: 7,
  viewed_work_keyword: 8,
  following_author: 9,
  brand_visit: 10,
});

// A condition's target is a BN254 field commitment made by the issuer from its
// normalized target ID/keyword. The circuit binds it to the activity policy;
// the issuer remains responsible for measuring the target-specific fact.
function uint(name, value, max = FIELD_PRIME) {
  if (value === undefined || value === null || !/^\d+$/.test(String(value))) throw new Error(`${name} must be a decimal integer`);
  const n = BigInt(value);
  if (n >= max) throw new Error(`${name} is out of range`);
  return n;
}

function normalizePolicy(policy) {
  if (!policy || typeof policy !== "object") throw new Error("policy is required");
  const rules = policy.rules || [];
  if (!Array.isArray(rules) || rules.length > RULE_SLOTS) throw new Error(`policy.rules must have at most ${RULE_SLOTS} items`);
  const matchMode = policy.match === "ALL" ? 0n : policy.match === "ANY" ? 1n : null;
  if (matchMode === null) throw new Error("policy.match must be ALL or ANY");
  const packed = rules.map((rule, i) => {
    const type = RULE[rule.type];
    if (!type) throw new Error(`policy.rules[${i}].type is unsupported`);
    const expectedOp = type === RULE.active_days ? OP.LE
      : [RULE.space_membership, RULE.viewed_work_keyword, RULE.following_author, RULE.brand_visit].includes(type) ? OP.EQ : OP.GE;
    if (Number(rule.operator) !== expectedOp) throw new Error(`policy.rules[${i}].operator is invalid`);
    const threshold = uint(`policy.rules[${i}].threshold`, rule.threshold, U64);
    const target = uint(`policy.rules[${i}].target`, rule.target || 0);
    if (expectedOp === OP.EQ && threshold !== 1n) throw new Error(`policy.rules[${i}] must compare to one`);
    return { type: BigInt(type), operator: BigInt(expectedOp), threshold, target };
  });
  while (packed.length < RULE_SLOTS) packed.push({ type: 0n, operator: 0n, threshold: 0n, target: 0n });
  return {
    minEvents: uint("policy.minEvents", policy.minEvents, U64),
    minDwellSeconds: uint("policy.minDwellSeconds", policy.minDwellSeconds, U64),
    notBefore: uint("policy.notBefore", policy.notBefore, U64),
    matchMode,
    rules: packed,
  };
}

function normalizeReceipt(receipt, policy) {
  if (!receipt || typeof receipt !== "object") throw new Error("receipt is required");
  const facts = receipt.facts;
  if (!Array.isArray(facts) || facts.length !== policy.rules.filter((rule) => rule.type !== 0n).length) {
    throw new Error("receipt.facts must match the campaign rule count");
  }
  const packedFacts = facts.map((value, i) => uint(`receipt.facts[${i}]`, value, U64));
  while (packedFacts.length < RULE_SLOTS) packedFacts.push(0n);
  return {
    subjectSecret: uint("receipt.subjectSecret", receipt.subjectSecret),
    eventCount: uint("receipt.eventCount", receipt.eventCount, U64),
    totalDwellSeconds: uint("receipt.totalDwellSeconds", receipt.totalDwellSeconds, U64),
    observedAt: uint("receipt.observedAt", receipt.observedAt, U64),
    receiptNonce: uint("receipt.receiptNonce", receipt.receiptNonce),
    facts: packedFacts,
  };
}

async function hashFunctions() {
  const poseidon = await buildPoseidon();
  return (values) => BigInt(poseidon.F.toString(poseidon(values.map(BigInt))));
}

function policyHash(policy, hash) {
  const reading = hash([policy.minEvents, policy.minDwellSeconds, policy.notBefore]);
  let chain = 0n;
  for (const rule of policy.rules) {
    chain = hash([chain, hash([rule.type, rule.operator, rule.threshold, rule.target])]);
  }
  return hash([reading, policy.matchMode, chain]);
}

function receiptLeaf(receipt, hash) {
  const base = hash([receipt.subjectSecret, receipt.eventCount, receipt.totalDwellSeconds, receipt.observedAt, receipt.receiptNonce]);
  let facts = 0n;
  for (const fact of receipt.facts) facts = hash([facts, fact]);
  return hash([base, facts]);
}

function matches(receipt, policy) {
  const reading = receipt.eventCount >= policy.minEvents
    && receipt.totalDwellSeconds >= policy.minDwellSeconds
    && receipt.observedAt >= policy.notBefore;
  const outcomes = policy.rules.map((rule, i) => {
    if (rule.type === 0n) return null;
    const fact = receipt.facts[i];
    return rule.operator === 1n ? fact >= rule.threshold
      : rule.operator === 2n ? fact <= rule.threshold : fact === rule.threshold;
  }).filter((value) => value !== null);
  return reading && (outcomes.length === 0 || (policy.matchMode === 0n ? outcomes.every(Boolean) : outcomes.some(Boolean)));
}

async function buildBatchV2(rawReceipts, rawPolicy) {
  if (!Array.isArray(rawReceipts) || rawReceipts.length < 1 || rawReceipts.length > MAX_LEAVES) {
    throw new Error(`receipts must contain 1-${MAX_LEAVES} items`);
  }
  const policy = normalizePolicy(rawPolicy);
  const receipts = rawReceipts.map((receipt) => normalizeReceipt(receipt, policy));
  const hash = await hashFunctions();
  const leaves = receipts.map((receipt) => receiptLeaf(receipt, hash));
  const levels = [Array(MAX_LEAVES).fill(0n)];
  leaves.forEach((leaf, index) => { levels[0][index] = leaf; });
  for (let depth = 0; depth < TREE_DEPTH; depth++) {
    const next = [];
    for (let i = 0; i < levels[depth].length; i += 2) next.push(hash([levels[depth][i], levels[depth][i + 1]]));
    levels.push(next);
  }
  return {
    root: levels[TREE_DEPTH][0],
    ruleHash: policyHash(policy, hash),
    leaves,
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

async function buildWitnessV2(rawReceipt, rawPolicy, campaignId, root, merkleProof, epoch = 0) {
  const policy = normalizePolicy(rawPolicy);
  const receipt = normalizeReceipt(rawReceipt, policy);
  const hash = await hashFunctions();
  if (!merkleProof || !Array.isArray(merkleProof.pathElements) || merkleProof.pathElements.length !== TREE_DEPTH
    || !Array.isArray(merkleProof.pathIndices) || merkleProof.pathIndices.length !== TREE_DEPTH) {
    throw new Error(`merkleProof must have ${TREE_DEPTH} path elements and indices`);
  }
  const id = uint("campaignId", campaignId);
  const claimEpoch = uint("epoch", epoch);
  return {
    evidenceRoot: uint("root", root),
    ruleHash: policyHash(policy, hash),
    nullifier: hash([receipt.subjectSecret, id, claimEpoch]),
    campaignId: id,
    epoch: claimEpoch,
    subjectSecret: receipt.subjectSecret,
    eventCount: receipt.eventCount,
    totalDwellSeconds: receipt.totalDwellSeconds,
    observedAt: receipt.observedAt,
    receiptNonce: receipt.receiptNonce,
    facts: receipt.facts,
    minEvents: policy.minEvents,
    minDwellSeconds: policy.minDwellSeconds,
    notBefore: policy.notBefore,
    matchMode: policy.matchMode,
    ruleTypes: policy.rules.map((rule) => rule.type),
    ruleOperators: policy.rules.map((rule) => rule.operator),
    ruleThresholds: policy.rules.map((rule) => rule.threshold),
    ruleTargets: policy.rules.map((rule) => rule.target),
    pathElements: merkleProof.pathElements.map((value, i) => uint(`pathElements[${i}]`, value)),
    pathIndices: merkleProof.pathIndices.map((value, i) => {
      const bit = Number(value);
      if (bit !== 0 && bit !== 1) throw new Error(`pathIndices[${i}] must be 0 or 1`);
      return bit;
    }),
  };
}

module.exports = { RULE_SLOTS, OP, RULE, normalizePolicy, normalizeReceipt, hashFunctions, policyHash, receiptLeaf, matches, buildBatchV2, buildWitnessV2, fieldHex };
