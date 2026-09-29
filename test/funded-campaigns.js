const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Funded TIME sponsorship campaigns", function () {
  async function deploy() {
    const [owner, issuer, advertiser, treasury, relayer] = await ethers.getSigners();
    const Registry = await ethers.getContractFactory("EvidenceRegistry");
    const registry = await Registry.deploy(issuer.address);
    const Verifier = await ethers.getContractFactory("MockPoEVerifier");
    const verifier = await Verifier.deploy();
    const Token = await ethers.getContractFactory("MockUSDC");
    const usdc = await Token.deploy();
    const Campaigns = await ethers.getContractFactory("FundedSponsorshipCampaigns");
    const campaigns = await Campaigns.deploy(registry.target, verifier.target, treasury.address, usdc.target);
    await usdc.mint(advertiser.address, 100_000_000n);
    await usdc.connect(advertiser).approve(campaigns.target, 100_000_000n);
    return { issuer, advertiser, treasury, relayer, registry, usdc, campaigns };
  }

  it("funds protocol treasury and binds a campaign manifest in one transaction", async function () {
    const { advertiser, treasury, usdc, campaigns } = await deploy();
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    await expect(campaigns.connect(advertiser).fundAndActivate(
      usdc.target, 5_000_000n, ethers.id("manifest-v1"), ethers.id("rules-v1"), ethers.ZeroHash,
      0, now + 1, 0, 600, 30, 0
    )).to.emit(campaigns, "CampaignFundedAndActivated");
    expect(await usdc.balanceOf(treasury.address)).to.equal(5_000_000n);
    const campaign = await campaigns.campaigns(1);
    expect(campaign.claimLimit).to.equal(20);
    expect(campaign.endsAt).to.equal(0);
    expect(campaign.claimPeriodSeconds).to.equal(0);
  });

  it("rejects a sub-minute claim period", async function () {
    const { advertiser, usdc, campaigns } = await deploy();
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    await expect(campaigns.connect(advertiser).fundAndActivate(
      usdc.target, 5_000_000n, ethers.id("manifest-v1"), ethers.id("rules-v1"), ethers.ZeroHash,
      0, now + 1, 0, 600, 30, 59
    )).to.be.revertedWithCustomError(campaigns, "InvalidCampaign");
  });

  it("rejects funding with an unapproved token", async function () {
    const { advertiser, usdc, campaigns } = await deploy();
    const OtherToken = await ethers.getContractFactory("MockUSDC");
    const other = await OtherToken.deploy();
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    await expect(campaigns.connect(advertiser).fundAndActivate(
      other.target, 5_000_000n, ethers.id("manifest-v1"), ethers.id("rules-v1"), ethers.ZeroHash,
      0, now + 1, 0, 600, 30, 0
    )).to.be.revertedWithCustomError(campaigns, "InvalidCampaign");
    expect(await usdc.balanceOf(campaigns.target)).to.equal(0);
  });

  it("binds ongoing claims to the evidence batch's committed policy", async function () {
    const { issuer, advertiser, relayer, usdc, campaigns, registry } = await deploy();
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    const root = ethers.id("ongoing-root");
    const rule = ethers.id("rules-v1");
    await registry.connect(issuer).commitEvidence(root, rule);
    await campaigns.connect(advertiser).fundAndActivate(usdc.target, 5_000_000n, ethers.id("manifest-v1"), rule,
      ethers.ZeroHash, 0, now + 120, now + 3600, 60, 30, 0);
    await ethers.provider.send("evm_setNextBlockTimestamp", [now + 120]);
    const nullifier = ethers.id("campaign-1-reader");
    await expect(campaigns.connect(relayer).claim(1, 1, nullifier, rule, 0, "0x706f652d64656d6f2d70726f6f66"))
      .to.emit(campaigns, "SponsorshipApproved");

    const otherRule = ethers.id("rules-v2");
    const later = (await ethers.provider.getBlock("latest")).timestamp;
    await campaigns.connect(advertiser).fundAndActivate(usdc.target, 5_000_000n, ethers.id("manifest-v2"), otherRule,
      ethers.ZeroHash, 0, later + 120, later + 3600, 60, 30, 0);
    await ethers.provider.send("evm_setNextBlockTimestamp", [later + 120]);
    await expect(campaigns.connect(relayer).claim(2, 1, ethers.id("n2"), otherRule, 0, "0x706f652d64656d6f2d70726f6f66"))
      .to.be.revertedWithCustomError(campaigns, "RuleMismatch");
  });

  it("uses a snapshot root for retrospective claims and blocks double claiming", async function () {
    const { advertiser, relayer, usdc, campaigns } = await deploy();
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    const root = ethers.id("anonymous-snapshot-root");
    const rule = ethers.id("rules-v1");
    await campaigns.connect(advertiser).fundAndActivate(usdc.target, 5_000_000n, ethers.id("manifest-v1"), rule,
      root, 1, now + 1, now + 3600, 60, 30, 0);
    const nullifier = ethers.id("campaign-1-reader");
    await expect(campaigns.connect(relayer).claim(1, 0, nullifier, rule, 0, "0x706f652d64656d6f2d70726f6f66"))
      .to.emit(campaigns, "SponsorshipApproved");
    await expect(campaigns.connect(relayer).claim(1, 0, nullifier, rule, 0, "0x706f652d64656d6f2d70726f6f66"))
      .to.be.revertedWithCustomError(campaigns, "AlreadyClaimed");
  });

  it("lets a repeatable campaign approve one claim per subject per period", async function () {
    const { advertiser, relayer, usdc, campaigns } = await deploy();
    const proof = "0x706f652d64656d6f2d70726f6f66";
    const rule = ethers.id("rules-v1");
    const start = (await ethers.provider.getBlock("latest")).timestamp + 1;
    // Like the live Copus sponsor: claimable again every hour, no end date.
    await campaigns.connect(advertiser).fundAndActivate(usdc.target, 5_000_000n, ethers.id("manifest-v1"), rule,
      ethers.id("snapshot"), 1, start, 0, 600, 30, 3600);
    await ethers.provider.send("evm_mine", []);

    const current = BigInt(Math.floor((await ethers.provider.getBlock("latest")).timestamp / 3600));
    const first = BigInt(Math.floor(start / 3600));
    await expect(campaigns.connect(relayer).claim(1, 0, ethers.id("n1"), rule, current, proof))
      .to.emit(campaigns, "SponsorshipApproved").withArgs(1, 0, ethers.id("n1"), rule, current);
    // An epoch from before the campaign started is never claimable, even if it is "previous".
    await expect(campaigns.connect(relayer).claim(1, 0, ethers.id("n0"), rule, first - 1n, proof))
      .to.be.revertedWithCustomError(campaigns, "EpochMismatch");
    await expect(campaigns.connect(relayer).claim(1, 0, ethers.id("n9"), rule, current + 1n, proof))
      .to.be.revertedWithCustomError(campaigns, "EpochMismatch");

    await ethers.provider.send("evm_increaseTime", [3600]);
    await ethers.provider.send("evm_mine", []);
    const later = BigInt(Math.floor((await ethers.provider.getBlock("latest")).timestamp / 3600));
    await expect(campaigns.connect(relayer).claim(1, 0, ethers.id("n2"), rule, later, proof))
      .to.emit(campaigns, "SponsorshipApproved");
    expect((await campaigns.campaigns(1)).approvedClaims).to.equal(2);
  });
});
