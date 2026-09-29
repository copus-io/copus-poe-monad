const fs = require("node:fs");
const path = require("node:path");
const snarkjs = require("snarkjs");
const { ethers } = require("hardhat");
const { buildBatchV2, buildWitnessV2 } = require("../lib/poe-v2");

async function main() {
  if ((await ethers.provider.getNetwork()).chainId !== 10143n) throw new Error("Monad Testnet only");
  const deployment = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "10143-v2.json")));
  const [signer] = await ethers.getSigners();
  if (signer.address !== deployment.deployer) throw new Error("unexpected deployer");
  const registry = await ethers.getContractAt("EvidenceRegistry", deployment.contracts.evidenceRegistry, signer);
  const campaigns = await ethers.getContractAt("FundedSponsorshipCampaignsV2", deployment.contracts.fundedSponsorshipCampaigns, signer);
  const token = await ethers.getContractAt("MockUSDC", deployment.fundingToken, signer);
  const campaignId = (await campaigns.campaignCount()) + 1n;
  const batchId = (await registry.batchCount()) + 1n;
  const now = (await ethers.provider.getBlock("latest")).timestamp;
  const policy = { minEvents: "3", minDwellSeconds: "90", notBefore: String(now - 3600), match: "ALL",
    rules: [
      { type: "active_days", operator: 2, threshold: "30", target: "0" },
      { type: "work_count", operator: 1, threshold: "1", target: "0" },
      { type: "brand_visit", operator: 3, threshold: "1", target: "12" },
    ] };
  const receipt = { subjectSecret: ethers.toBigInt(ethers.randomBytes(16)).toString(), eventCount: "4",
    totalDwellSeconds: "145", observedAt: String(now), receiptNonce: "77", facts: ["2", "1", "1"] };
  const batch = await buildBatchV2([receipt], policy);
  const witness = await buildWitnessV2(receipt, policy, campaignId, batch.root, batch.proof(0), 0);
  const artifacts = path.join(__dirname, "..", "zk-v2-artifacts");
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(witness,
    path.join(artifacts, "poe-v2.wasm"), path.join(artifacts, "poe-v2_final.zkey"));
  const verificationKey = JSON.parse(fs.readFileSync(path.join(artifacts, "verification_key.json")));
  if (!await snarkjs.groth16.verify(verificationKey, publicSignals, proof)) throw new Error("invalid local proof");
  const field = (n) => ethers.toBeHex(n, 32);
  const payment = 1_000_000n;
  const commit = await (await registry.commitEvidence(field(batch.root), field(batch.ruleHash))).wait();
  const mint = await (await token.mint(signer.address, payment)).wait();
  const approve = await (await token.approve(campaigns.target, payment)).wait();
  const startsAt = (await ethers.provider.getBlock("latest")).timestamp + 10;
  const fund = await (await campaigns.fundAndActivateWithExpectedId(campaignId, token.target, payment,
    ethers.id("monad-testnet-demo-v2"), field(batch.ruleHash), ethers.ZeroHash, 0,
    startsAt, 0, 60, 30, 0)).wait();
  while ((await ethers.provider.getBlock("latest")).timestamp < startsAt) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  const call = JSON.parse(`[${await snarkjs.groth16.exportSolidityCallData(proof, publicSignals)}]`);
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(["uint256[2]", "uint256[2][2]", "uint256[2]"], call.slice(0, 3));
  const claim = await (await campaigns.claim(campaignId, batchId, field(witness.nullifier),
    field(witness.ruleHash), 0, encoded)).wait();
  const approved = claim.logs.some((log) => {
    try { return campaigns.interface.parseLog(log)?.name === "SponsorshipApproved"; } catch { return false; }
  });
  if (!approved || !(await campaigns.usedNullifiers(campaignId, field(witness.nullifier)))
      || await token.balanceOf(deployment.treasury) < payment) throw new Error("claim or funding verification failed");
  let duplicateRejected = false;
  try { await campaigns.claim.staticCall(campaignId, batchId, field(witness.nullifier), field(witness.ruleHash), 0, encoded); }
  catch (error) { duplicateRejected = error.data?.slice(0, 10) === campaigns.interface.getError("AlreadyClaimed").selector; }
  if (!duplicateRejected) throw new Error("duplicate claim was not rejected as AlreadyClaimed");
  console.log(JSON.stringify({ campaignId: campaignId.toString(), batchId: batchId.toString(),
    commitTx: commit.hash, mintTx: mint.hash, approveTx: approve.hash, fundTx: fund.hash,
    claimTx: claim.hash, duplicateRejected, treasuryTestTokenBalance: (await token.balanceOf(deployment.treasury)).toString() }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
