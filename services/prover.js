const http = require("http");
const path = require("path");
const snarkjs = require("snarkjs");
const { TREE_DEPTH, buildWitness, fieldHex } = require("../lib/poe");
const { buildWitnessV2, normalizePolicy, normalizeReceipt } = require("../lib/poe-v2");
const { parseBearerTokens, validBearer } = require("./bearer");

/**
 * Server-side prover.
 *
 * The Copus backend sends one receipt, its Merkle path, the campaign policy and
 * the epoch; this service returns a Groth16 proof the relayer can submit. The
 * browser never downloads proving artifacts and never sees a proof, so the
 * reader's claim stays a single authenticated POST on every device, including
 * WebViews that cannot run snarkjs.
 *
 * This service holds no secrets of its own. It does receive subject secrets in
 * requests, so it must only listen on a private interface and behind a token.
 */
const artifacts = path.join(__dirname, "..", "zk-artifacts");
const v2Artifacts = path.join(__dirname, "..", "zk-v2-artifacts");
const MAX_BODY_BYTES = 200_000;

function invalid(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function bigintField(value, name) {
  if (value === undefined || value === null || value === "") throw invalid(`${name} is required`);
  try {
    const parsed = BigInt(value);
    if (parsed < 0n) throw new Error();
    return parsed;
  } catch {
    throw invalid(`${name} must be a non-negative integer`);
  }
}

function validate(input) {
  if (!input || typeof input !== "object") throw invalid("prove input is required");
  const receipt = input.receipt || {};
  const policy = input.policy || {};
  const merkleProof = input.merkleProof || {};
  for (const key of ["subjectSecret", "eventCount", "totalDwellSeconds", "observedAt", "receiptNonce"]) bigintField(receipt[key], `receipt.${key}`);
  for (const key of ["minEvents", "minDwellSeconds", "notBefore"]) bigintField(policy[key], `policy.${key}`);
  if (Number(policy.version) === 2) normalizeReceipt(receipt, normalizePolicy(policy));
  bigintField(input.campaignId, "campaignId");
  bigintField(input.root, "root");
  const epoch = input.epoch === undefined ? 0n : bigintField(input.epoch, "epoch");
  if (!Array.isArray(merkleProof.pathElements) || merkleProof.pathElements.length !== TREE_DEPTH) throw invalid(`merkleProof.pathElements must have ${TREE_DEPTH} entries`);
  if (!Array.isArray(merkleProof.pathIndices) || merkleProof.pathIndices.length !== TREE_DEPTH) throw invalid(`merkleProof.pathIndices must have ${TREE_DEPTH} entries`);
  merkleProof.pathElements.forEach((value, index) => bigintField(value, `merkleProof.pathElements[${index}]`));
  merkleProof.pathIndices.forEach((value, index) => {
    if (Number(value) !== 0 && Number(value) !== 1) throw invalid(`merkleProof.pathIndices[${index}] must be 0 or 1`);
  });
  return { receipt, policy, merkleProof, campaignId: input.campaignId, root: input.root, epoch };
}

async function prove(rawInput) {
  const input = validate(rawInput);
  const v2 = Number(input.policy.version) === 2;
  const witness = v2
    ? await buildWitnessV2(input.receipt, input.policy, input.campaignId, input.root, input.merkleProof, input.epoch)
    : await buildWitness(input.receipt, input.policy, input.campaignId, input.root, input.merkleProof, input.epoch);
  let proof;
  let publicSignals;
  try {
    ({ proof, publicSignals } = await snarkjs.groth16.fullProve(
      witness, path.join(v2 ? v2Artifacts : artifacts, v2 ? "poe-v2.wasm" : "poe.wasm"),
      path.join(v2 ? v2Artifacts : artifacts, v2 ? "poe-v2_final.zkey" : "poe_final.zkey")
    ));
  } catch (error) {
    // The circuit refused the witness: the receipt is below the rule, or the path does not
    // resolve to the root. Either way there is no valid proof, and no gas should be spent.
    const rejected = new Error("receipt does not satisfy the campaign rule");
    rejected.status = 422;
    rejected.cause = error;
    throw rejected;
  }
  const call = JSON.parse(`[${await snarkjs.groth16.exportSolidityCallData(proof, publicSignals)}]`);
  return {
    evidenceRoot: fieldHex(witness.evidenceRoot),
    ruleHash: fieldHex(witness.ruleHash),
    nullifier: fieldHex(witness.nullifier),
    campaignId: witness.campaignId.toString(),
    epoch: witness.epoch.toString(),
    publicSignals,
    solidityProof: { a: call[0], b: call[1], c: call[2] },
  };
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; if (body.length > MAX_BODY_BYTES) request.destroy(); });
    request.on("end", () => { try { resolve(JSON.parse(body)); } catch (error) { reject(invalid("body must be JSON")); } });
    request.on("error", reject);
  });
}

function createServer({ token, tokens }) {
  // Same rotatable, timing-safe bearer handling as the relayer and issuer API.
  const accepted = parseBearerTokens(tokens, token);
  if (accepted.length === 0 || accepted.some((value) => Buffer.byteLength(value, "utf8") < 32)) {
    throw new Error("PROVER_TOKEN / PROVER_TOKENS must contain 32+ byte tokens");
  }
  return http.createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url === "/healthz") return response.end('{"ok":true}');
    if (request.method !== "POST" || request.url !== "/prove" || !validBearer(request, accepted)) {
      response.statusCode = 404; return response.end('{"error":"not found"}');
    }
    try {
      const result = await prove(await readJson(request));
      response.statusCode = 200;
      response.end(JSON.stringify(result));
    } catch (error) {
      response.statusCode = error.status || 500;
      response.end(JSON.stringify({ error: error.status ? error.message : "proving failed" }));
    }
  });
}

async function main() {
  const server = createServer({ tokens: process.env.PROVER_TOKENS, token: process.env.PROVER_TOKEN });
  server.listen(Number(process.env.PROVER_PORT || 8790), process.env.BIND_HOST || "127.0.0.1");
}

if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });

module.exports = { prove, createServer };
