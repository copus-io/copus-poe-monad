const http = require("http");
const { parseBearerTokens, validBearer } = require("./bearer");

// Local development stand-in for the Copus backend settlement endpoint
// (docs/INTEGRATION.md). It checks the bearer credential and idempotency key,
// logs every payload the indexer delivers, and acknowledges it — no real TIME
// ledger exists on a local chain. Never deploy this anywhere real.
const seen = new Set();

async function main() {
  const tokens = parseBearerTokens(process.env.SETTLEMENT_TOKENS, process.env.SETTLEMENT_TOKEN);
  if (tokens.length === 0) throw new Error("SETTLEMENT_TOKEN or SETTLEMENT_TOKENS is required");
  http.createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    const url = new URL(request.url, "http://localhost");
    if (request.method === "GET" && url.pathname === "/healthz") return response.end('{"ok":true}');
    if (request.method !== "POST" || !validBearer(request, tokens)) {
      response.statusCode = 404; return response.end('{"error":"not found"}');
    }
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const payload = JSON.parse(body || "{}");
      const key = request.headers["idempotency-key"];
      const duplicate = seen.has(key);
      seen.add(key);
      console.log(JSON.stringify({ credited: !duplicate, ...payload }));
      response.end(JSON.stringify({ ok: true, duplicate }));
    });
  }).listen(Number(process.env.SETTLEMENT_PORT || 8791), "127.0.0.1"); // 8790 belongs to the prover
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
