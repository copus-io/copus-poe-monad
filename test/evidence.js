const { expect } = require("chai");
const { buildBatch, buildWitness, FIELD_PRIME } = require("../lib/poe");

describe("PoE evidence tooling", function () {
  it("builds distinct membership paths that resolve to one root", async function () {
    const receipts = [
      { subjectSecret: 11n, eventCount: 3n, totalDwellSeconds: 100n, observedAt: 1_800_000_000n, receiptNonce: 1n },
      { subjectSecret: 22n, eventCount: 5n, totalDwellSeconds: 200n, observedAt: 1_800_000_001n, receiptNonce: 2n },
    ];
    const batch = await buildBatch(receipts);
    const policy = { minEvents: 3n, minDwellSeconds: 90n, notBefore: 1_700_000_000n };
    const first = await buildWitness(receipts[0], policy, 7n, batch.root, batch.proof(0));
    const second = await buildWitness(receipts[1], policy, 7n, batch.root, batch.proof(1));
    expect(first.evidenceRoot).to.equal(second.evidenceRoot);
    expect(first.pathElements[0]).to.equal(batch.leaves[1]);
    expect(second.pathElements[0]).to.equal(batch.leaves[0]);
    expect(first.nullifier).not.to.equal(second.nullifier);
    // The same subject in the same campaign gets a different nullifier per epoch.
    const nextEpoch = await buildWitness(receipts[0], policy, 7n, batch.root, batch.proof(0), 1n);
    expect(nextEpoch.nullifier).not.to.equal(first.nullifier);
    expect(nextEpoch.epoch).to.equal(1n);
    expect(first.epoch).to.equal(0n);
  });

  it("derives the claim epoch from the campaign period", async function () {
    const { claimEpoch } = require("../lib/poe");
    expect(claimEpoch(1_800_000_000n, 0)).to.equal(0n);
    expect(claimEpoch(1_800_000_000n, 3600)).to.equal(500_000n);
    expect(claimEpoch(1_800_003_599n, 3600)).to.equal(500_000n);
    expect(claimEpoch(1_800_003_600n, 3600)).to.equal(500_001n);
  });

  it("rejects empty batches and invalid proof indexes", async function () {
    await expect(buildBatch([])).to.be.rejectedWith("receipts must contain");
    const receipt = { subjectSecret: 1, eventCount: 3, totalDwellSeconds: 90, observedAt: 1, receiptNonce: 1 };
    const batch = await buildBatch([receipt]);
    expect(() => batch.proof(1)).to.throw("invalid receipt index");
  });

  it("rejects field values outside the circuit domain", async function () {
    const over64 = { subjectSecret: 1n, eventCount: 1n << 64n, totalDwellSeconds: 90n, observedAt: 1n, receiptNonce: 1n };
    await expect(buildBatch([over64])).to.be.rejectedWith("out of range");
    const overField = { subjectSecret: FIELD_PRIME, eventCount: 3n, totalDwellSeconds: 90n, observedAt: 1n, receiptNonce: 1n };
    await expect(buildBatch([overField])).to.be.rejectedWith("out of range");
    const receipt = { subjectSecret: 1n, eventCount: 3n, totalDwellSeconds: 90n, observedAt: 1n, receiptNonce: 1n };
    const batch = await buildBatch([receipt]);
    const policy = { minEvents: 3n, minDwellSeconds: 90n, notBefore: 1n };
    await expect(buildWitness(receipt, policy, FIELD_PRIME, batch.root, batch.proof(0))).to.be.rejectedWith("campaignId");
  });
});
