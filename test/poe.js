const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Copus Proof of Experience", function () {
  async function deploy() {
    const [owner, issuer, advertiser, reader] = await ethers.getSigners();
    const Registry = await ethers.getContractFactory("EvidenceRegistry");
    const registry = await Registry.deploy(issuer.address);
    const Verifier = await ethers.getContractFactory("MockPoEVerifier");
    const verifier = await Verifier.deploy();
    const Campaigns = await ethers.getContractFactory("SponsorshipCampaigns");
    const campaigns = await Campaigns.deploy(registry.target, verifier.target);
    return { owner, issuer, advertiser, reader, registry, campaigns };
  }

  it("records only evidence commitments and approves a qualifying claim once", async function () {
    const { issuer, advertiser, reader, registry, campaigns } = await deploy();
    const root = ethers.keccak256(ethers.toUtf8Bytes("private-merkle-root"));
    const rule = ethers.keccak256(ethers.toUtf8Bytes("active-7-days"));
    await registry.connect(issuer).commitEvidence(root, rule);
    const block = await ethers.provider.getBlock("latest");
    await campaigns.createCampaign(advertiser.address, rule, block.timestamp, block.timestamp + 3600, 2, 0);
    const nullifier = ethers.keccak256(ethers.toUtf8Bytes("campaign-1-reader-secret"));
    await expect(campaigns.connect(reader).claim(1, 1, nullifier, rule, 0, "0x706f652d64656d6f2d70726f6f66"))
      .to.emit(campaigns, "SponsorshipApproved");
    await expect(campaigns.connect(reader).claim(1, 1, nullifier, rule, 0, "0x706f652d64656d6f2d70726f6f66"))
      .to.be.revertedWithCustomError(campaigns, "AlreadyClaimed");
    // A lifetime campaign has exactly one epoch; any other value is not a claimable epoch.
    await expect(campaigns.connect(reader).claim(1, 1, ethers.id("other"), rule, 1, "0x706f652d64656d6f2d70726f6f66"))
      .to.be.revertedWithCustomError(campaigns, "EpochMismatch");
  });

  it("allows one claim per period when the campaign sets a claim period", async function () {
    const { issuer, advertiser, reader, registry, campaigns } = await deploy();
    const proof = "0x706f652d64656d6f2d70726f6f66";
    const rule = ethers.id("hourly");
    await registry.connect(issuer).commitEvidence(ethers.id("root"), rule); // batch policy must equal the campaign rule
    const start = (await ethers.provider.getBlock("latest")).timestamp;
    await expect(campaigns.createCampaign(advertiser.address, rule, start, start + 100_000, 10, 30))
      .to.be.revertedWithCustomError(campaigns, "InvalidCampaign"); // sub-minute periods are nonsense
    await campaigns.createCampaign(advertiser.address, rule, start, start + 100_000, 10, 3600);

    const now = (await ethers.provider.getBlock("latest")).timestamp;
    const current = BigInt(Math.floor(now / 3600));
    // The prover cannot pick a future epoch, nor one older than the previous.
    await expect(campaigns.connect(reader).claim(1, 1, ethers.id("n1"), rule, current + 1n, proof))
      .to.be.revertedWithCustomError(campaigns, "EpochMismatch");
    await expect(campaigns.connect(reader).claim(1, 1, ethers.id("n1"), rule, current - 2n, proof))
      .to.be.revertedWithCustomError(campaigns, "EpochMismatch");
    await expect(campaigns.connect(reader).claim(1, 1, ethers.id("n1"), rule, current, proof))
      .to.emit(campaigns, "SponsorshipApproved").withArgs(1, 1, ethers.id("n1"), rule, current);

    // Next period: a fresh (campaign, epoch) nullifier is a fresh claim.
    await ethers.provider.send("evm_increaseTime", [3600]);
    await ethers.provider.send("evm_mine", []);
    const later = BigInt(Math.floor((await ethers.provider.getBlock("latest")).timestamp / 3600));
    await expect(campaigns.connect(reader).claim(1, 1, ethers.id("n2"), rule, later, proof))
      .to.emit(campaigns, "SponsorshipApproved");
    // The previous epoch is still accepted, so a proof made just before a boundary is not wasted.
    await expect(campaigns.connect(reader).claim(1, 1, ethers.id("n3"), rule, later - 1n, proof))
      .to.emit(campaigns, "SponsorshipApproved");
  });

  it("rejects claims against batches committed under a different policy", async function () {
    const { issuer, advertiser, reader, registry, campaigns } = await deploy();
    const root = ethers.keccak256(ethers.toUtf8Bytes("private-merkle-root"));
    const batchPolicy = ethers.keccak256(ethers.toUtf8Bytes("poe-v1"));
    const rule = ethers.keccak256(ethers.toUtf8Bytes("active-7-days"));
    await registry.connect(issuer).commitEvidence(root, batchPolicy);
    const block = await ethers.provider.getBlock("latest");
    await campaigns.createCampaign(advertiser.address, rule, block.timestamp, block.timestamp + 3600, 2, 0);
    await expect(campaigns.connect(reader).claim(1, 1, ethers.id("n"), rule, 0, "0x706f652d64656d6f2d70726f6f66"))
      .to.be.revertedWithCustomError(campaigns, "RuleMismatch");
  });

  it("rejects a proof fixture that does not verify", async function () {
    const { issuer, advertiser, reader, registry, campaigns } = await deploy();
    const root = ethers.keccak256(ethers.toUtf8Bytes("root"));
    const rule = ethers.keccak256(ethers.toUtf8Bytes("rule"));
    await registry.connect(issuer).commitEvidence(root, rule);
    const block = await ethers.provider.getBlock("latest");
    await campaigns.createCampaign(advertiser.address, rule, block.timestamp, block.timestamp + 3600, 1, 0);
    await expect(campaigns.connect(reader).claim(1, 1, ethers.id("n"), rule, 0, "0x00"))
      .to.be.revertedWithCustomError(campaigns, "InvalidProof");
  });
});
