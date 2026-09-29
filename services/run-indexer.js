const path = require("path");
const { ethers } = require("ethers");
const artifact = require("../artifacts/contracts/FundedSponsorshipCampaigns.sol/FundedSponsorshipCampaigns.json");
const v2Artifact = require("../artifacts/contracts/FundedSponsorshipCampaignsV2.sol/FundedSponsorshipCampaignsV2.json");
const { SqliteCheckpointStore, SponsorshipSettlementIndexer, postSettlement } = require("./settlement-indexer");

async function main() {
  for (const key of ["RPC_URL", "CAMPAIGN_CONTRACT_ADDRESS", "SETTLEMENT_URL", "SETTLEMENT_TOKEN"]) {
    if (!process.env[key]) throw new Error(`${key} is required`);
  }
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const network = await provider.getNetwork();
  const selected = Number(process.env.POE_VERSION) === 2 ? v2Artifact : artifact;
  const contract = new ethers.Contract(process.env.CAMPAIGN_CONTRACT_ADDRESS, selected.abi, provider);
  const store = new SqliteCheckpointStore(process.env.INDEXER_DB || path.join(process.cwd(), "poe-indexer.db"));
  const indexer = new SponsorshipSettlementIndexer({
    provider, contract, store, chainId: network.chainId,
    startBlock: Number(process.env.START_BLOCK || 0), confirmations: Number(process.env.CONFIRMATIONS || 3),
    maxAttempts: Number(process.env.MAX_ATTEMPTS || 10),
    settle: (payload) => postSettlement(process.env.SETTLEMENT_URL, process.env.SETTLEMENT_TOKEN, payload),
  });
  const interval = Number(process.env.POLL_INTERVAL_MS || 10_000);
  for (;;) {
    try { console.log(JSON.stringify(await indexer.tick())); }
    catch (error) { console.error(error); }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
