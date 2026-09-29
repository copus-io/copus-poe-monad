const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const snarkjs = require("snarkjs");
const { ethers } = require("hardhat");
const { buildBatchV2, buildWitnessV2, matches, normalizePolicy, normalizeReceipt } = require("../lib/poe-v2");
const { prepareV2Campaign } = require("../lib/policy-v2-source");

const wasm = path.join(__dirname, "..", "zk-v2-build", "poe-v2_js", "poe-v2.wasm");
const r1cs = path.join(__dirname, "..", "zk-v2-build", "poe-v2.r1cs");
const policy = {
  minEvents: "3", minDwellSeconds: "90", notBefore: "1700000000", match: "ALL",
  rules: [
    { type: "active_days", operator: 2, threshold: "30", target: "0" },
    { type: "work_count", operator: 1, threshold: "1", target: "0" },
    { type: "brand_visit", operator: 3, threshold: "1", target: "12" },
  ],
};
const receipt = {
  subjectSecret: "912345", eventCount: "4", totalDwellSeconds: "145",
  observedAt: "1800000000", receiptNonce: "77", facts: ["2", "1", "1"],
};

describe("PoE v2 condition proof", function () {
  this.timeout(120_000);
  before(function () {
    if (!fs.existsSync(wasm) || !fs.existsSync(r1cs)) this.skip();
  });

  async function calculate(candidate, campaignPolicy = policy) {
    const batch = await buildBatchV2([candidate], campaignPolicy);
    const input = await buildWitnessV2(candidate, campaignPolicy, 1, batch.root, batch.proof(0), 0);
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "poe-v2-test-"));
    try {
      const witnessPath = path.join(temporary, "witness.wtns");
      await snarkjs.wtns.calculate(input, wasm, witnessPath);
      return await snarkjs.wtns.check(r1cs, witnessPath);
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }

  it("checks every condition and the issuer-committed policy", async function () {
    expect(matches(normalizeReceipt(receipt, normalizePolicy(policy)), normalizePolicy(policy))).to.equal(true);
    expect(await calculate(receipt)).to.equal(true);
  });

  it("rejects a missing brand visit in ALL mode", async function () {
    const ineligible = { ...receipt, facts: ["2", "1", "0"] };
    expect(matches(normalizeReceipt(ineligible, normalizePolicy(policy)), normalizePolicy(policy))).to.equal(false);
    let failed = false;
    try { await calculate(ineligible); } catch { failed = true; }
    expect(failed).to.equal(true);
  });

  it("accepts one matching condition in ANY mode and rejects none", async function () {
    const any = { ...policy, match: "ANY" };
    expect(await calculate({ ...receipt, facts: ["50", "1", "0"] }, any)).to.equal(true);
    let failed = false;
    try { await calculate({ ...receipt, facts: ["50", "0", "0"] }, any); } catch { failed = true; }
    expect(failed).to.equal(true);
  });

  it("rejects a policy or fact whose value exceeds 64 bits", async function () {
    expect(() => normalizePolicy({ ...policy, rules: [{ ...policy.rules[0], threshold: (1n << 64n).toString() }] })).to.throw();
    expect(() => normalizeReceipt({ ...receipt, facts: [(1n << 64n).toString(), "1", "1"] }, normalizePolicy(policy))).to.throw();
  });

  it("prepares the same immutable rule hash from public and hidden draft conditions", async function () {
    const prepared = await prepareV2Campaign({
      match: "ALL", destinationUrl: "https://brand.example/", notBefore: 1700000000,
      publicRules: [{ type: "work_count", value: 1 }, { type: "brand_visit", value: true }],
      hiddenRules: [{ type: "following_author", value: "9, 3 9" }],
    });
    expect(prepared.provingPolicy.rules[2].threshold).to.equal("1");
    expect(prepared.provingPolicy.rules[2].target).to.match(/^\d+$/);
    expect(prepared.sourceRulesJson).to.include('"visibility":"HIDDEN"');
    const hash = await require("../lib/poe-v2").hashFunctions();
    expect(prepared.ruleHash).to.equal(require("../lib/poe").fieldHex(
      require("../lib/poe-v2").policyHash(normalizePolicy(prepared.provingPolicy), hash)
    ));
  });

  it("verifies a real v2 proof in the funded campaign contract", async function () {
    const artifacts = path.join(__dirname, "..", "zk-v2-artifacts");
    if (!fs.existsSync(path.join(artifacts, "poe-v2_final.zkey"))) this.skip();
    this.timeout(180_000);
    const [owner, issuer, advertiser, treasury] = await ethers.getSigners();
    const batch = await buildBatchV2([receipt], policy);
    const witness = await buildWitnessV2(receipt, policy, 1, batch.root, batch.proof(0), 0);
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      witness, path.join(artifacts, "poe-v2.wasm"), path.join(artifacts, "poe-v2_final.zkey")
    );
    const key = JSON.parse(fs.readFileSync(path.join(artifacts, "verification_key.json"), "utf8"));
    expect(await snarkjs.groth16.verify(key, publicSignals, proof)).to.equal(true);
    expect(publicSignals.map(BigInt)).to.deep.equal([
      witness.evidenceRoot, witness.ruleHash, witness.nullifier, witness.campaignId, witness.epoch,
    ]);

    const registry = await (await ethers.getContractFactory("EvidenceRegistry")).deploy(issuer.address);
    const verifier = await (await ethers.getContractFactory("PoEV2Groth16Verifier")).deploy();
    const adapter = await (await ethers.getContractFactory("PoEVerifierAdapter")).deploy(verifier.target);
    const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    const campaigns = await (await ethers.getContractFactory("FundedSponsorshipCampaignsV2"))
      .deploy(registry.target, adapter.target, treasury.address, usdc.target);
    await registry.connect(issuer).commitEvidence(ethers.toBeHex(batch.root, 32), ethers.toBeHex(batch.ruleHash, 32));
    await usdc.mint(advertiser.address, 1_000_000n);
    await usdc.connect(advertiser).approve(campaigns.target, 1_000_000n);
    const startsAt = (await ethers.provider.getBlock("latest")).timestamp + 1;
    await campaigns.connect(advertiser).fundAndActivate(usdc.target, 1_000_000n, ethers.id("v2-manifest"),
      ethers.toBeHex(batch.ruleHash, 32), ethers.ZeroHash, 0, startsAt, 0, 30, 30, 0);
    const call = JSON.parse(`[${await snarkjs.groth16.exportSolidityCallData(proof, publicSignals)}]`);
    const encoded = ethers.AbiCoder.defaultAbiCoder().encode(["uint256[2]", "uint256[2][2]", "uint256[2]"], call.slice(0, 3));
    await expect(campaigns.connect(owner).claim(1, 1, ethers.toBeHex(witness.nullifier, 32),
      ethers.toBeHex(witness.ruleHash, 32), 0, encoded)).to.emit(campaigns, "SponsorshipApproved");
  });
});
