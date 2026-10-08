// Create a separate immutable campaign contract for the hosted testnet demo.
// The existing registry/verifier remain unchanged. Keys and output stay outside Git.
const fs = require('node:fs');
const { ethers } = require('ethers');
const { evmRequest } = require('../services/rpc-network');
async function main() {
  const [keyPath, manifestPath, output] = process.argv.slice(2);
  if (!keyPath || !manifestPath || !output || fs.existsSync(output)) throw new Error('Supply a private operator, existing deployment and new output path');
  if (fs.statSync(keyPath).mode & 0o077) throw new Error('Operator key must be mode 0600');
  const base = JSON.parse(fs.readFileSync(manifestPath));
  const provider = new ethers.JsonRpcProvider(evmRequest(process.env.RPC_URL || 'https://testnet-rpc.monad.xyz', ethers));
  if ((await provider.getNetwork()).chainId !== 10143n || base.chainId !== 10143) throw new Error('Monad Testnet required');
  const signer = new ethers.Wallet(JSON.parse(fs.readFileSync(keyPath)).privateKey, provider);
  const registry = new ethers.Contract(base.contracts.evidenceRegistry, ['function issuers(address) view returns (bool)'], provider);
  if (!await registry.issuers(signer.address)) throw new Error('Operator is not an authorized issuer');
  const artifact = require('../artifacts/contracts/FundedSponsorshipCampaignsV2.sol/FundedSponsorshipCampaignsV2.json');
  const contract = await new ethers.ContractFactory(artifact.abi, artifact.bytecode, signer).deploy(base.contracts.evidenceRegistry, base.contracts.verifierAdapter, base.treasury, base.fundingToken);
  const receipt = await contract.deploymentTransaction().wait(2);
  if (receipt.status !== 1) throw new Error('Campaign deployment failed');
  const saved = { ...base, contracts: { ...base.contracts, fundedSponsorshipCampaigns: await contract.getAddress() }, sourceCommit: process.env.POE_RELEASE_COMMIT, deployedAt: new Date().toISOString(), minimumClaimMinutes: 10, campaignDeploymentTransaction: receipt.hash };
  fs.writeFileSync(output, JSON.stringify(saved, null, 2)+'\n', {mode:0o600,flag:'wx'});
  console.log(JSON.stringify({campaigns:saved.contracts.fundedSponsorshipCampaigns,transaction:receipt.hash,minimumClaimMinutes:10}));
}
main().catch(error => {console.error(error.shortMessage || error.message);process.exitCode=1;});
