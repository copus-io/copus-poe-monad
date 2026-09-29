const crypto = require("crypto");
const { ethers } = require("ethers");
const { FIELD_PRIME } = require("./poe");
const { RULE_SLOTS, RULE, OP, normalizePolicy, hashFunctions, policyHash, fieldHex } = require("./poe-v2");

function integer(name, value, min, max) {
  if (!/^\d+$/.test(String(value))) throw new Error(`${name} must be an integer`);
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`${name} is out of range`);
  return n;
}

function target(text) {
  const digest = crypto.createHash("sha256").update(text, "utf8").digest("hex");
  return (BigInt(`0x${digest}`) % FIELD_PRIME).toString();
}

function ids(value) {
  const parts = String(value).trim().split(/[\s,，]+/).filter(Boolean);
  if (!parts.length || parts.length > 20 || parts.some((part) => !/^[1-9]\d{0,17}$/.test(part))) {
    throw new Error("target must contain 1-20 numeric IDs");
  }
  return [...new Set(parts.map(BigInt))].sort((a, b) => a < b ? -1 : a > b ? 1 : 0).join(",");
}

function normalizeRule(raw, destinationUrl) {
  if (!raw || !RULE[raw.type]) throw new Error(`unsupported condition: ${raw?.type}`);
  const value = raw.value;
  let operator;
  let threshold;
  let targetValue = "0";
  switch (raw.type) {
    case "active_days":
      operator = OP.LE; threshold = integer(raw.type, value, 1, 365) * 86400; break;
    case "work_count": case "comment_count": case "space_count":
      operator = OP.GE; threshold = integer(raw.type, value, 0, 10_000_000); break;
    case "time_spent":
      operator = OP.GE; threshold = integer(raw.type, value, 0, 10_000_000) * 60 + 1; break;
    case "followers":
      operator = OP.GE; threshold = integer(raw.type, value, 0, 10_000_000) + 1; break;
    case "space_membership": case "following_author":
      operator = OP.EQ; threshold = 1; targetValue = target(ids(value)); break;
    case "viewed_work_keyword": {
      const word = String(value).trim().toLowerCase();
      if (word.length < 2 || word.length > 80) throw new Error("keyword must be 2-80 characters");
      operator = OP.EQ; threshold = 1; targetValue = target(word); break;
    }
    case "brand_visit": {
      if (value !== true) throw new Error("brand_visit must be enabled");
      const url = new URL(destinationUrl);
      if (url.protocol !== "https:" || !url.hostname || url.username || url.password) throw new Error("destinationUrl must be HTTPS");
      operator = OP.EQ; threshold = 1; targetValue = target(destinationUrl.trim()); break;
    }
  }
  return { type: raw.type, operator, threshold: String(threshold), target: targetValue };
}

async function prepareV2Campaign(draft) {
  if (!draft || typeof draft !== "object") throw new Error("draft is required");
  const publicRules = draft.publicRules || [];
  const hiddenRules = draft.hiddenRules || [];
  if (!Array.isArray(publicRules) || !Array.isArray(hiddenRules)
    || publicRules.length + hiddenRules.length > RULE_SLOTS) throw new Error(`a campaign supports at most ${RULE_SLOTS} conditions`);
  if (hiddenRules.some((rule) => rule.type === "brand_visit")) throw new Error("brand_visit must be public");
  const source = {
    match: draft.match,
    rules: [
      ...publicRules.map((rule) => ({ type: rule.type, value: rule.value, visibility: "PUBLIC" })),
      ...hiddenRules.map((rule) => ({ type: rule.type, value: rule.value, visibility: "HIDDEN" })),
    ],
  };
  const proving = {
    version: 2,
    minEvents: String(integer("minEvents", draft.minEvents ?? 0, 0, 10_000_000)),
    minDwellSeconds: String(integer("minDwellSeconds", draft.minDwellSeconds ?? 0, 0, 10_000_000)),
    notBefore: String(integer("notBefore", draft.notBefore, 0, 9_999_999_999)),
    match: draft.match,
    rules: source.rules.map((rule) => normalizeRule(rule, draft.destinationUrl)),
  };
  const hash = fieldHex(policyHash(normalizePolicy(proving), await hashFunctions()));
  const manifest = {
    version: 2, title: draft.title, description: draft.description, coverUrl: draft.coverUrl,
    destinationUrl: draft.destinationUrl, rules: source, provingPolicy: proving,
    totalTimeMinutes: draft.totalTimeMinutes, claimTimeMinutes: draft.claimTimeMinutes,
    startsAt: draft.startsAt, endsAt: draft.endsAt, mode: draft.mode,
  };
  return {
    sourceRulesJson: JSON.stringify(source),
    provingPolicy: proving,
    ruleHash: hash,
    manifestHash: ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(manifest))),
    manifest,
  };
}

module.exports = { prepareV2Campaign, normalizeRule, target, ids };
