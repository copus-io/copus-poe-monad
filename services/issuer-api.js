const http = require("http");
const fs = require("fs");
const { parseBearerTokens, validBearer } = require("./bearer");
const { ALG, loadKey, decryptJson } = require("../lib/batch-crypto");

// Serves each subject exactly their own receipt summary and Merkle path from a
// committed batch file produced by scripts/build-batch.js. Called only by the
// authenticated Copus API layer; the browser never sees ISSUER_API_TOKEN(S).
async function main() {
  if (!process.env.BATCH_PATH) throw new Error("BATCH_PATH is required");
  const tokens = parseBearerTokens(process.env.ISSUER_API_TOKENS, process.env.ISSUER_API_TOKEN);
  if (tokens.length === 0) throw new Error("ISSUER_API_TOKEN or ISSUER_API_TOKENS is required");

  const batchPath = process.env.BATCH_PATH;
  const batchId = process.env.BATCH_ID || null;
  const batchKey = process.env.BATCH_ENCRYPTION_KEY ? loadKey(process.env.BATCH_ENCRYPTION_KEY) : null;

  // The batch file holds every subject's witness material. Refuse to serve
  // from a file that is readable by group/other, and refuse plaintext when an
  // encryption key was configured — both mean the operator meant encryption.
  const stat = fs.statSync(batchPath);
  if (stat.mode & 0o077) {
    throw new Error(`${batchPath} must be owner-only (run: chmod 600 ${batchPath})`);
  }
  const loadBatch = () => {
    const parsed = JSON.parse(fs.readFileSync(batchPath, "utf8"));
    if (parsed.alg === ALG) {
      if (!batchKey) throw new Error("batch file is encrypted but BATCH_ENCRYPTION_KEY is not set");
      return decryptJson(parsed, batchKey);
    }
    if (batchKey) throw new Error("batch file is not encrypted but BATCH_ENCRYPTION_KEY is set");
    return parsed;
  };

  const server = http.createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    const url = new URL(request.url, "http://localhost");
    if (request.method === "GET" && url.pathname === "/healthz") return response.end('{"ok":true}');
    if (!validBearer(request, tokens)) {
      response.statusCode = 404; return response.end('{"error":"not found"}');
    }
    try {
      if (request.method === "GET" && url.pathname === "/batch") {
        const batch = loadBatch();
        return response.end(JSON.stringify({ root: batch.root, size: batch.size, batchId, ruleHash: batch.ruleHash ?? null }));
      }
      if (request.method === "GET" && url.pathname === "/evidence") {
        const subject = url.searchParams.get("subject");
        const batch = loadBatch();
        const entry = batch.entries?.find((item) => item.subjectRef === subject);
        if (!subject || !entry) {
          response.statusCode = 404; return response.end('{"error":"no evidence for subject"}');
        }
        return response.end(JSON.stringify({
          subjectRef: entry.subjectRef,
          batchId,
          root: batch.root,
          ruleHash: batch.ruleHash ?? null,
          policy: batch.policy ?? null,
          leafIndex: entry.leafIndex,
          receipt: entry.receipt,
          pathElements: entry.pathElements,
          pathIndices: entry.pathIndices,
        }));
      }
      response.statusCode = 404; response.end('{"error":"not found"}');
    } catch (error) {
      response.statusCode = 400; response.end(JSON.stringify({ error: error.message }));
    }
  });
  server.listen(Number(process.env.ISSUER_PORT || process.env.PORT || 8789), process.env.BIND_HOST || "127.0.0.1");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
