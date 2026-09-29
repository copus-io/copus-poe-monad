const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function waitForCode(address) {
  for (let attempt = 0; attempt < 12; attempt++) {
    if (await hre.ethers.provider.getCode(address) !== "0x") return;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new Error(`No bytecode at ${address}`);
}

async function main() {
  const network = await hre.ethers.provider.getNetwork();
  if (network.chainId !== 10143n) throw new Error(`Refusing unexpected chain ${network.chainId}`);
  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) throw new Error("DEPLOYER_PRIVATE_KEY is required");
  const issuer = hre.ethers.getAddress(process.env.ISSUER_ADDRESS || "");
  const treasury = hre.ethers.getAddress(process.env.TREASURY_ADDRESS || "");
  const fundingToken = hre.ethers.getAddress(process.env.FUNDING_TOKEN_ADDRESS || "");
  await waitForCode(fundingToken);
  const Registry = await hre.ethers.getContractFactory("EvidenceRegistry");
  const registry = await Registry.deploy(issuer);
  await registry.waitForDeployment();

  const Verifier = await hre.ethers.getContractFactory("PoEV2Groth16Verifier");
  const verifier = await Verifier.deploy();
  await verifier.waitForDeployment();
  const Adapter = await hre.ethers.getContractFactory("PoEVerifierAdapter");
  const adapter = await Adapter.deploy(verifier.target);
  await adapter.waitForDeployment();
  const Campaigns = await hre.ethers.getContractFactory("FundedSponsorshipCampaignsV2");
  const campaigns = await Campaigns.deploy(registry.target, adapter.target, treasury, fundingToken);
  await campaigns.waitForDeployment();

  const contracts = [registry, verifier, adapter, campaigns];
  const receipts = await Promise.all(contracts.map((contract) => contract.deploymentTransaction().wait()));
  receipts.forEach((receipt, index) => {
    if (receipt.status !== 1 || receipt.contractAddress.toLowerCase() !== contracts[index].target.toLowerCase()) {
      throw new Error(`V2 deployment ${index} receipt mismatch`);
    }
  });
  await Promise.all(contracts.map((contract) => waitForCode(contract.target)));
  if (await adapter.groth16Verifier() !== verifier.target
      || await campaigns.registry() !== registry.target
      || await campaigns.verifier() !== adapter.target
      || await campaigns.treasury() !== treasury
      || await campaigns.fundingToken() !== fundingToken
      || !await registry.issuers(issuer)
      || await campaigns.MAX_EVIDENCE_AGE_SECONDS() !== 86400n) {
    throw new Error("V2 deployment wiring mismatch");
  }
  const deployment = {
    version: 2,
    chainId: Number(network.chainId),
    deployer: deployer.address,
    issuer, treasury, fundingToken,
    contracts: {
      evidenceRegistry: registry.target,
      groth16Verifier: verifier.target,
      verifierAdapter: adapter.target,
      fundedSponsorshipCampaigns: campaigns.target,
    },
    deploymentTransactions: {
      evidenceRegistry: receipts[0].hash,
      groth16Verifier: receipts[1].hash,
      verifierAdapter: receipts[2].hash,
      fundedSponsorshipCampaigns: receipts[3].hash,
    },
    deploymentBlock: Math.max(...receipts.map((receipt) => receipt.blockNumber)),
    sourceCommit: process.env.DEPLOYMENT_SOURCE_SHA || null,
    workflowRunId: process.env.DEPLOYMENT_RUN_ID || null,
    deployedAt: new Date().toISOString(),
  };
  const output = path.join(__dirname, "..", "deployments", `${network.chainId}-v2.json`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(deployment, null, 2)}\n`, { flag: "wx" });
  console.log(`Deployment manifest written to ${output}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
