const fs = require('node:fs');
const path = require('node:path');
const { ethers } = require('ethers');
const { buildBatchV2, fieldHex } = require('../lib/poe-v2');
const { prove } = require('./prover');
const { validateCampaignSchedule } = require('./campaign-schedule');

async function createChain() {
  const live = process.env.POE_DEMO_NETWORK === 'testnet';
  const fork = live && process.env.POE_DEMO_FORK === '1';
  let provider, signer, registry, campaigns, token, deployment;
  if (live) {
    const manifest = process.env.POE_DEMO_DEPLOYMENT || path.join(__dirname, '../deployments/10143-v2.json');
    deployment = JSON.parse(fs.readFileSync(manifest));
    if (![84532, 10143].includes(deployment.chainId)) throw new Error('testnet deployment required');
    const keyPath = process.env.POE_DEMO_KEY_PATH;
    if (keyPath && fs.statSync(keyPath).mode & 0o077) throw new Error('demo key file must be owner-only');
    const privateKey = keyPath ? JSON.parse(fs.readFileSync(keyPath)).privateKey : process.env.POE_DEMO_PRIVATE_KEY;
    if (!privateKey || !process.env.RPC_URL) throw new Error('RPC_URL and POE_DEMO_PRIVATE_KEY are required for testnet');
    provider = new ethers.JsonRpcProvider(require('./rpc-network').evmRequest(process.env.RPC_URL, ethers));
    if ((await provider.getNetwork()).chainId !== BigInt(deployment.chainId)) throw new Error('RPC chain mismatch');
    signer = new ethers.NonceManager(new ethers.Wallet(privateKey, provider));
    registry = new ethers.Contract(deployment.contracts.evidenceRegistry, require('../artifacts/contracts/EvidenceRegistry.sol/EvidenceRegistry.json').abi, signer);
    campaigns = new ethers.Contract(deployment.contracts.fundedSponsorshipCampaigns, require('../artifacts/contracts/FundedSponsorshipCampaignsV2.sol/FundedSponsorshipCampaignsV2.json').abi, signer);
    token = new ethers.Contract(deployment.fundingToken, require('../artifacts/contracts/MockUSDC.sol/MockUSDC.json').abi, signer);
    if (!await registry.issuers(await signer.getAddress())) throw new Error('demo signer must be an authorized issuer');
  } else {
    const hre = require('hardhat');
    provider = hre.ethers.provider;
    const signers = await hre.ethers.getSigners();
    signer = signers[0];
    const deploy = async (name, ...args) => { const c = await (await hre.ethers.getContractFactory(name, signer)).deploy(...args); await c.waitForDeployment(); return c; };
    token = await deploy('MockUSDC');
    registry = await deploy('EvidenceRegistry', await signer.getAddress());
    const verifier = await deploy('PoEV2Groth16Verifier');
    const adapter = await deploy('PoEVerifierAdapter', verifier.target);
    campaigns = await deploy('FundedSponsorshipCampaignsV2', registry.target, adapter.target, signers[1].address, token.target);
    await (await token.mint(await signer.getAddress(), 1_000_000_000_000n)).wait();
    deployment = { chainId: 31337, contracts: { evidenceRegistry: registry.target, fundedSponsorshipCampaigns: campaigns.target }, fundingToken: token.target };
  }
  const explorer = deployment.chainId === 10143 ? 'https://testnet.monadscan.com/tx/' : 'https://sepolia.basescan.org/tx/';
  const wait = async (tx) => { const receipt = await tx.wait(live ? 3 : 1, 180_000); if (!receipt || receipt.status !== 1) throw new Error('transaction did not confirm'); return receipt; };
  return {
    label: fork ? 'Local Monad fork · Anvil' : live ? deployment.chainId === 10143 ? 'Monad Testnet' : 'Base Sepolia' : 'Local EVM · real v2 verifier',
    deployment, live: live && !fork,
    link: (hash) => live && !fork ? explorer + hash : null,
    async status(campaign, row) {
      const mined=await provider.getTransactionReceipt(row.tx);
      if(!mined)return null;
      if(mined.status!==1)return {failed:'Claim reverted on chain'};
      if(live && (await provider.getBlockNumber())-mined.blockNumber+1<3)return null;
      if((await provider.getBlock(mined.blockNumber)).hash!==mined.blockHash)return null;
      const log=mined.logs.find((log)=>{try{const e=campaigns.interface.parseLog(log);return log.address.toLowerCase()===campaigns.target.toLowerCase()&&e?.name==='SponsorshipApproved'&&String(e.args.campaignId)===campaign.id&&e.args.nullifier.toLowerCase()===row.nullifier?.toLowerCase()&&String(e.args.epoch)===row.epoch&&e.args.ruleHash.toLowerCase()===campaign.ruleHash.toLowerCase();}catch{return false;}});
      if(!log)return {failed:'No matching approval event'};
      return {eventKey:`${deployment.chainId}:${row.tx}:${log.index}`,timeSeconds:campaign.draft.claimTimeMinutes*60};
    },
    async fund(draft, prepared, receipt) {
      const now = (await provider.getBlock('latest')).timestamp;
      validateCampaignSchedule(draft,now*1000);
      const id = (await campaigns.campaignCount()) + 1n;
      const retrospective = draft.mode === 'RETROSPECTIVE';
      let batch = null, batchId = null;
      if (retrospective) {
        batch = await buildBatchV2([receipt], prepared.provingPolicy);
        const committed = await wait(await registry.commitEvidence(fieldHex(batch.root), fieldHex(batch.ruleHash)));
        batchId = registry.interface.parseLog(committed.logs.find((log) => log.address.toLowerCase() === registry.target.toLowerCase())).args.batchId.toString();
      }
      const payment = 1_000_000n; // Freely mintable local/Monad test token; Base test USDC needs a funded wallet.
      if (await token.balanceOf(await signer.getAddress()) < payment) {
        if (deployment.chainId !== 10143 || process.env.POE_DEMO_MINT_TEST_TOKEN !== '1') throw new Error('insufficient test funding tokens');
        await wait(await token.mint(await signer.getAddress(), payment));
      }
      await wait(await token.approve(campaigns.target, payment));
      const period = draft.repeatClaim ? Number(draft.claimTimeMinutes) * 60 : 0;
      // Evidence, minting and approval may take longer than the default start delay.
      const readyAt = (await provider.getBlock('latest')).timestamp;
      const {startsAt:start,endsAt:end}=validateCampaignSchedule(draft,readyAt*1000);
      const funded = await wait(await campaigns.fundAndActivateWithExpectedId(id, token.target, payment, prepared.manifestHash, prepared.ruleHash,
        batch ? fieldHex(batch.root) : ethers.ZeroHash, retrospective ? 1 : 0, start, end,
        draft.totalTimeMinutes, draft.claimTimeMinutes, period));
      // Funding must not advance local chain time past a sponsor's chosen start.
      return { id: id.toString(), transactionHash: funded.hash, startsAt: start, period, batchId,
        root: batch?.root.toString(), merkleProof: batch && { pathElements: batch.proof(0).pathElements.map(String), pathIndices: batch.proof(0).pathIndices }, paymentUnits: payment.toString() };
    },
    async epoch(campaign) { return campaign.period ? Math.floor((await provider.getBlock('latest')).timestamp / campaign.period) : 0; },
    async claim(campaign, receipt, requestedEpoch) {
      const epoch = requestedEpoch ?? await this.epoch(campaign);
      let root = campaign.root, merkleProof = campaign.merkleProof, batchId = campaign.batchId;
      if (campaign.draft.mode !== 'RETROSPECTIVE') {
        const batch = await buildBatchV2([receipt], campaign.policy);
        const committed = await wait(await registry.commitEvidence(fieldHex(batch.root), fieldHex(batch.ruleHash)));
        batchId = registry.interface.parseLog(committed.logs.find((log) => log.address.toLowerCase() === registry.target.toLowerCase())).args.batchId.toString();
        root = batch.root.toString();
        merkleProof = { pathElements: batch.proof(0).pathElements.map(String), pathIndices: batch.proof(0).pathIndices };
      }
      const result = await prove({ receipt, policy: campaign.policy, campaignId: campaign.id, root, merkleProof, epoch });
      const proof = ethers.AbiCoder.defaultAbiCoder().encode(['uint256[2]', 'uint256[2][2]', 'uint256[2]'], [result.solidityProof.a, result.solidityProof.b, result.solidityProof.c]);
      const args = [campaign.id, batchId, result.nullifier, result.ruleHash, epoch, proof];
      await campaigns.claim.staticCall(...args);
      const tx = await campaigns.claim(...args);
      return { transactionHash: tx.hash, epoch: String(epoch), nullifier: result.nullifier,
        finalize: async () => {
          const mined = await wait(tx);
          const event = mined.logs.map((log) => { try { return campaigns.interface.parseLog(log); } catch { return null; } })
            .find((log) => log?.name === 'SponsorshipApproved' && log.args.campaignId === BigInt(campaign.id) && log.args.nullifier === result.nullifier);
          if (!event) throw new Error('confirmed transaction has no matching approval event');
          const canonical = await provider.getBlock(mined.blockNumber);
          if (canonical.hash !== mined.blockHash) throw new Error('approval block is no longer canonical');
          return { eventKey: `${deployment.chainId}:${mined.hash}:${mined.logs.find((log) => { try { const parsed = campaigns.interface.parseLog(log); return parsed?.name === 'SponsorshipApproved' && parsed.args.nullifier === result.nullifier; } catch { return false; } }).index}`, timeSeconds: Number(campaign.draft.claimTimeMinutes) * 60 };
        } };
    },
  };
}
module.exports = { createChain };
