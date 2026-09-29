const crypto = require("crypto");

const ALG = "aes-256-gcm";

// A batch file contains every subject's receipt and Merkle path — the most
// sensitive artifact in the system. When BATCH_ENCRYPTION_KEY (64 hex chars,
// i.e. a 32-byte key) is set, build-batch writes this envelope instead of
// plaintext and issuer-api decrypts it in memory. The envelope stays JSON so
// it can travel anywhere a .json file can.
function loadKey(hex) {
  if (!/^[0-9a-fA-F]{64}$/.test(String(hex || ""))) {
    throw new Error("BATCH_ENCRYPTION_KEY must be 64 hex characters (32 bytes)");
  }
  return Buffer.from(hex, "hex");
}

function encryptJson(value, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALG, key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return {
    v: 1,
    alg: ALG,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}

function decryptJson(envelope, key) {
  if (envelope?.alg !== ALG) throw new Error("not an aes-256-gcm batch envelope");
  const decipher = crypto.createDecipheriv(ALG, key, Buffer.from(envelope.iv, "base64"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const plain = Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]);
  return JSON.parse(plain.toString("utf8"));
}

module.exports = { ALG, loadKey, encryptJson, decryptJson };
