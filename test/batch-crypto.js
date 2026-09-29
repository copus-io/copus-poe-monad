const { expect } = require("chai");
const crypto = require("crypto");
const { ALG, loadKey, encryptJson, decryptJson } = require("../lib/batch-crypto");

const KEY = crypto.randomBytes(32).toString("hex");

describe("batch encryption", function () {
  it("round-trips a batch payload through the envelope", function () {
    const batch = { root: "0x01", size: 2, entries: [{ subjectRef: "u:1", receipt: { subjectSecret: "7" } }] };
    const envelope = encryptJson(batch, loadKey(KEY));
    expect(envelope.alg).to.equal(ALG);
    expect(envelope.data).to.not.include("subjectSecret");
    expect(decryptJson(envelope, loadKey(KEY))).to.deep.equal(batch);
  });

  it("rejects the wrong key and tampered ciphertext", function () {
    const envelope = encryptJson({ root: "0x01" }, loadKey(KEY));
    expect(() => decryptJson(envelope, loadKey(crypto.randomBytes(32).toString("hex")))).to.throw();
    const tampered = { ...envelope, data: `${envelope.data.slice(0, -4)}AAAA` };
    expect(() => decryptJson(tampered, loadKey(KEY))).to.throw();
  });

  it("validates the key format", function () {
    expect(() => loadKey("not-hex")).to.throw("64 hex");
    expect(() => loadKey("aa".repeat(32))).to.not.throw();
  });
});
