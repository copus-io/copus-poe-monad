require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config({ quiet: true });

/** Testnet deployment configuration is intentionally not committed. */
module.exports = {
  solidity: {
    version: "0.8.24",
    // Activation deliberately binds a complete campaign manifest in one call;
    // viaIR keeps this audited, single-transaction ABI without stack limits.
    settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true }
  },
  networks: {
    monadTestnet: {
      url: process.env.MONAD_TESTNET_RPC_URL || "https://testnet-rpc.monad.xyz",
      chainId: 10143,
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : []
    }
  }
};
