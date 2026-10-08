const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Funded PoE v2 evidence freshness", function () {
  it("allows ten-minute allocations and rejects smaller ones before payment", async function () {
    const [, issuer, advertiser, treasury] = await ethers.getSigners();
    const registry = await (await ethers.getContractFactory("EvidenceRegistry")).deploy(issuer.address);
    const verifier = await (await ethers.getContractFactory("MockPoEVerifier")).deploy();
    const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    const campaigns = await (await ethers.getContractFactory("FundedSponsorshipCampaignsV2"))
      .deploy(registry.target, verifier.target, treasury.address, usdc.target);
    await usdc.mint(advertiser.address, 1_000_000n);
    await usdc.connect(advertiser).approve(campaigns.target, 1_000_000n);
    const start = (await ethers.provider.getBlock("latest")).timestamp + 10;
    const args = [usdc.target, 1_000_000n, ethers.id("manifest"), ethers.id("policy"), ethers.ZeroHash, 0, start, 0, 6000];
    await expect(campaigns.connect(advertiser).fundAndActivate(...args, 9, 0))
      .to.be.reverted;
    expect(await usdc.balanceOf(treasury.address)).to.equal(0);
    await campaigns.connect(advertiser).fundAndActivate(...args, 10, 0);
    expect(await usdc.balanceOf(treasury.address)).to.equal(1_000_000n);
  });
  it("fails before charging when a retrospective precomputed campaign ID is stale", async function () {
    const [, issuer, advertiser, treasury] = await ethers.getSigners();
    const registry = await (await ethers.getContractFactory("EvidenceRegistry")).deploy(issuer.address);
    const verifier = await (await ethers.getContractFactory("MockPoEVerifier")).deploy();
    const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    const campaigns = await (await ethers.getContractFactory("FundedSponsorshipCampaignsV2"))
      .deploy(registry.target, verifier.target, treasury.address, usdc.target);
    await usdc.mint(advertiser.address, 1_000_000n);
    await usdc.connect(advertiser).approve(campaigns.target, 1_000_000n);
    const start = (await ethers.provider.getBlock("latest")).timestamp + 1;
    await expect(campaigns.connect(advertiser).fundAndActivateWithExpectedId(2, usdc.target, 1_000_000n,
      ethers.id("manifest"), ethers.id("policy"), ethers.id("snapshot"), 1, start, 0, 30, 30, 0))
      .to.be.revertedWithCustomError(campaigns, "CampaignIdChanged");
    expect(await usdc.balanceOf(treasury.address)).to.equal(0);
  });

  it("rejects an old ongoing batch while allowing a fixed retrospective snapshot", async function () {
    const [, issuer, advertiser, treasury] = await ethers.getSigners();
    const registry = await (await ethers.getContractFactory("EvidenceRegistry")).deploy(issuer.address);
    const verifier = await (await ethers.getContractFactory("MockPoEVerifier")).deploy();
    const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    const campaigns = await (await ethers.getContractFactory("FundedSponsorshipCampaignsV2"))
      .deploy(registry.target, verifier.target, treasury.address, usdc.target);
    const proof = "0x706f652d64656d6f2d70726f6f66";
    const rule = ethers.id("v2-policy");
    const root = ethers.id("v2-root");
    await registry.connect(issuer).commitEvidence(root, rule);
    await usdc.mint(advertiser.address, 10_000_000n);
    await usdc.connect(advertiser).approve(campaigns.target, 10_000_000n);
    const start = (await ethers.provider.getBlock("latest")).timestamp + 1;
    await campaigns.connect(advertiser).fundAndActivate(usdc.target, 1_000_000n, ethers.id("manifest"), rule,
      ethers.ZeroHash, 0, start, 0, 30, 30, 0);
    await ethers.provider.send("evm_increaseTime", [86401]);
    await ethers.provider.send("evm_mine", []);
    await expect(campaigns.claim(1, 1, ethers.id("reader"), rule, 0, proof))
      .to.be.revertedWithCustomError(campaigns, "EvidenceTooOld");

    const now = (await ethers.provider.getBlock("latest")).timestamp;
    await campaigns.connect(advertiser).fundAndActivate(usdc.target, 1_000_000n, ethers.id("snapshot-manifest"), rule,
      root, 1, now + 1, 0, 30, 30, 0);
    await expect(campaigns.claim(2, 0, ethers.id("retrospective-reader"), rule, 0, proof))
      .to.emit(campaigns, "SponsorshipApproved");
  });
});
