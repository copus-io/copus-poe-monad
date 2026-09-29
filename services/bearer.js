const crypto = require("crypto");

// Comma-separated token lists let operators rotate credentials without a
// downtime window: add the new token, redeploy clients, drop the old one.
function parseBearerTokens(...values) {
  return values
    .flatMap((value) => String(value || "").split(","))
    .map((value) => value.trim())
    .filter(Boolean);
}

function validBearer(request, tokens) {
  const header = request.headers.authorization || "";
  if (!header.startsWith("Bearer ")) return false;
  const presented = Buffer.from(header.slice(7), "utf8");
  return tokens.some((token) => {
    const expected = Buffer.from(token, "utf8");
    return presented.length === expected.length && crypto.timingSafeEqual(presented, expected);
  });
}

module.exports = { parseBearerTokens, validBearer };
