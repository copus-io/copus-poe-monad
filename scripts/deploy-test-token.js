const hre = require("hardhat");

async function main() {
  const network = await hre.ethers.provider.getNetwork();
  if (network.chainId !== 10143n) throw new Error(`unexpected chain ${network.chainId}`);
  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) throw new Error("DEPLOYER_PRIVATE_KEY is required");
  const Token = await hre.ethers.getContractFactory("MockUSDC");
  const token = await Token.deploy();
  const receipt = await token.deploymentTransaction().wait();
  if (receipt.status !== 1 || receipt.contractAddress.toLowerCase() !== token.target.toLowerCase()) {
    throw new Error("test token deployment failed");
  }
  console.log(JSON.stringify({ chainId: Number(network.chainId), token: token.target,
    transactionHash: receipt.hash, deployer: deployer.address }, null, 2));
  console.log("This token is freely mintable and is for isolated testnet demos only.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
