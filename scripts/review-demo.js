const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const fork=process.argv.includes('--fork');
if(fs.existsSync(path.join(root,'.env')))process.loadEnvFile(path.join(root,'.env'));
function privateJson(file,value){fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});fs.writeFileSync(file,JSON.stringify(value)+'\n',{mode:0o600,flag:'wx'});}
function readPrivate(file){if(fs.statSync(file).mode&0o077)throw new Error('Wallet file must be mode 0600');return JSON.parse(fs.readFileSync(file));}
function ui(dir){
  const archive=path.join(root,'demo-ui/copus-ui.tar.gz'); const manifest=JSON.parse(fs.readFileSync(path.join(root,'demo-ui/manifest.json')));
  if(crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex')!==manifest.sha256)throw new Error('Copus UI archive checksum mismatch');
  const listing=spawnSync('tar',['-tzf',archive],{encoding:'utf8'});if(listing.status!==0)throw new Error('Cannot inspect Copus UI archive');
  if(listing.stdout.split('\n').some(n=>n.startsWith('/')||n.split('/').includes('..')))throw new Error('Unsafe UI archive entry');
  const out=path.join(dir,'ui',manifest.sha256);if(!fs.existsSync(path.join(out,'index.html'))){fs.mkdirSync(out,{recursive:true});if(spawnSync('tar',['-xzf',archive,'-C',out],{stdio:'inherit'}).status!==0)throw new Error('Cannot extract Copus UI');}
  return out;
}
async function prepare(dir) {
  const {ethers}=require('ethers'); const {evmRequest}=require('../services/rpc-network');
  const rpc=fork ? (process.env.POE_FORK_RPC_URL || 'http://127.0.0.1:8545') : (process.env.RPC_URL || process.env.MONAD_TESTNET_RPC_URL || 'https://testnet-rpc.monad.xyz');
  if(fork && !['127.0.0.1','localhost','[::1]'].includes(new URL(rpc).hostname))throw new Error('Fork RPC must be loopback');
  if(fork)delete process.env.POE_RPC_PROXY;
  const provider=new ethers.JsonRpcProvider(evmRequest(rpc,ethers));
  if((await provider.getNetwork()).chainId!==10143n)throw new Error('Monad Testnet (10143) required');
  if(fork){const info=await provider.send('anvil_metadata',[]);if(info.forkedNetwork?.chainId!==10143)throw new Error('Anvil must fork Monad Testnet');console.log('LOCAL Monad fork:',JSON.stringify(info.forkedNetwork));}
  const keyFile=process.env.POE_DEMO_KEY_PATH || path.join(dir,'operator.json');
  if(!fs.existsSync(keyFile)){const wallet=ethers.Wallet.createRandom();privateJson(keyFile,{address:wallet.address,privateKey:wallet.privateKey});}
  const wallet=new ethers.Wallet(readPrivate(keyFile).privateKey,provider);
  console.log(`${fork?'Local Monad fork':'Monad Testnet'} operator: ${wallet.address}`);
  if(fork)await provider.send('anvil_setBalance',[wallet.address,ethers.toQuantity(ethers.parseEther('100'))]);
  const balance=await provider.getBalance(wallet.address);
  if(balance<ethers.parseEther('0.05'))throw new Error(`Add test MON to ${wallet.address} at https://faucet.monad.xyz, then rerun pnpm demo:product. Your wallet is stored privately at ${keyFile}.`);
  const manifest=process.env.POE_DEMO_DEPLOYMENT || path.join(dir,'deployment.json');
  if(!fs.existsSync(manifest)){
    const hre=require('hardhat');await hre.run('compile');
    const signer=new ethers.NonceManager(wallet);
    const deploy=async(name,...args)=>{const artifact=await hre.artifacts.readArtifact(name);const c=await new ethers.ContractFactory(artifact.abi,artifact.bytecode,signer).deploy(...args);await c.waitForDeployment();return c;};
    console.log(fork?'Deploying contracts on LOCAL Anvil fork only.':'Creating your own isolated testnet deployment. This does not change the published Copus contracts.');
    const token=await deploy('MockUSDC');const registry=await deploy('EvidenceRegistry',wallet.address);
    const verifier=await deploy('PoEV2Groth16Verifier');const adapter=await deploy('PoEVerifierAdapter',verifier.target);
    const treasury=ethers.Wallet.createRandom().address;
    const campaigns=await deploy('FundedSponsorshipCampaignsV2',registry.target,adapter.target,treasury,token.target);
    privateJson(manifest,{version:2,chainId:10143,issuer:wallet.address,treasury,fundingToken:token.target,contracts:{evidenceRegistry:registry.target,groth16Verifier:verifier.target,verifierAdapter:adapter.target,fundedSponsorshipCampaigns:campaigns.target}});
  } else if(!fs.existsSync(path.join(root,'artifacts/contracts/FundedSponsorshipCampaignsV2.sol/FundedSponsorshipCampaignsV2.json'))){await require('hardhat').run('compile');}
  if(fork){const saved=JSON.parse(fs.readFileSync(manifest));if(await provider.getCode(saved.contracts.fundedSponsorshipCampaigns)==='0x')throw new Error('Fork was reset. Use a fresh POE_REVIEW_DATA directory for this new Anvil instance.');}
  Object.assign(process.env,{POE_DEMO_NETWORK:'testnet',POE_DEMO_FORK:fork?'1':'0',RPC_URL:rpc,POE_DEMO_KEY_PATH:keyFile,POE_DEMO_DEPLOYMENT:manifest,POE_DEMO_MINT_TEST_TOKEN:'1',POE_DEMO_CHAIN:'monad-testnet'});
}
async function main(){
  if(Number(process.versions.node.split('.')[0])<22)throw new Error('Node.js 22 or newer is required');
  const dir=process.env.POE_REVIEW_DATA || path.join(os.homedir(),fork?'.local/share/copus-poe-review/monad-fork':'.local/share/copus-poe-review/monad');
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  process.env.POE_WEB_ROOT=ui(dir); await prepare(dir);
  const port=process.env.POE_DEMO_PORT || '8792';
  Object.assign(process.env,{POE_DEMO_DATA:process.env.POE_DEMO_DATA||path.join(dir,'ledger'),POE_DEMO_PUBLIC_ORIGIN:`http://localhost:${port}`});
  if(process.env.POE_REVIEW_SETUP_ONLY==='1')return;
  console.log(`Open http://localhost:${port}/time-sponsors?sponsorshipDemo=1`);
  console.log(fork?'LOCAL FORK transactions only; fixture experience data and isolated TIME ledger.':'Real testnet transactions; fixture experience data and an isolated TIME ledger. No Copus production API access.');
  await require('../services/product-demo').main();
}
main().catch(error=>{console.error(error.message);process.exitCode=1});
