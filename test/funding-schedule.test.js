const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {createRequire}=require('node:module');
const path=require('node:path');

// Run the real adapter with deterministic RPC/transaction confirmations, without broadcasting.
async function harness(t) {
  let now=Date.parse('2030-01-01T00:00:00Z')/1000;
  const initial=now, calls=[];
  const prepared={manifestHash:'0x'+'1'.repeat(64),ruleHash:'0x'+'2'.repeat(64)};
  const file=path.join(__dirname,'../services/product-chain.js');
  const realRequire=createRequire(file);
  const module={exports:{}};
  const tx=(kind)=>{calls.push({kind});return {wait:async()=>{now+=45;return {status:1,hash:kind};}};};
  const provider={getNetwork:async()=>({chainId:10143n}),getBlock:async()=>({timestamp:now})};
  const signer={getAddress:async()=>'issuer'};
  const contracts={
    registry:{issuers:async()=>true},
    token:{balanceOf:async()=>0n,mint:async()=>tx('mint'),approve:async()=>tx('approve')},
    campaigns:{target:'campaigns',campaignCount:async()=>0n,fundAndActivateWithExpectedId:async(...args)=>{
      calls.push({kind:'fund',start:args[7],end:args[8]});
      return {wait:async()=>({status:1,hash:'fund'})};
    }},
  };
  const deployment={chainId:10143,contracts:{evidenceRegistry:'registry',fundedSponsorshipCampaigns:'campaigns'},fundingToken:'token'};
  const env={POE_DEMO_NETWORK:'testnet',POE_DEMO_PRIVATE_KEY:'fixture-only',RPC_URL:'http://fixture',POE_DEMO_MINT_TEST_TOKEN:'1'};
  const mocks={
    'node:fs':{readFileSync:()=>JSON.stringify(deployment)},
    ethers:{ethers:{JsonRpcProvider:function(){return provider;},Wallet:function(){return signer;},NonceManager:function(){return signer;},Contract:function(address){return contracts[address];},ZeroHash:'0x'+'0'.repeat(64)}},
    './rpc-network':{evmRequest:()=>({})},
    '../artifacts/contracts/EvidenceRegistry.sol/EvidenceRegistry.json':{abi:[]},
    '../artifacts/contracts/FundedSponsorshipCampaignsV2.sol/FundedSponsorshipCampaignsV2.json':{abi:[]},
    '../artifacts/contracts/MockUSDC.sol/MockUSDC.json':{abi:[]},
  };
  vm.runInNewContext(fs.readFileSync(file,'utf8'),{require:id=>id in mocks?mocks[id]:realRequire(id),module,exports:module.exports,process:{env},__dirname:path.dirname(file),Buffer,console,setTimeout,Date});
  const chain=await module.exports.createChain();
  return {initial,calls,now:()=>now,fund:draft=>chain.fund({mode:'ONGOING',totalTimeMinutes:6000,claimTimeMinutes:30,...draft},prepared,{})};
}

test('slow preparation refreshes an omitted start before campaign creation',async t=>{
  const h=await harness(t);const result=await h.fund({unlimited:true});
  assert.ok(h.now()-h.initial>30);
  assert.equal(result.startsAt,h.now()+30);
  assert.equal(h.calls.at(-1).start,result.startsAt);
});
test('slow preparation preserves a still-future explicit start',async t=>{
  const h=await harness(t);const start=h.initial+3600;
  const result=await h.fund({unlimited:true,startsAt:new Date(start*1000).toISOString()});
  assert.equal(result.startsAt,start);assert.equal(h.calls.at(-1).start,start);
});
test('explicit start that expires during preparation prevents campaign creation',async t=>{
  const h=await harness(t);
  await assert.rejects(h.fund({unlimited:true,startsAt:new Date((h.initial+40)*1000).toISOString()}),/Start time must be in the future/);
  assert.ok(h.calls.length>0);assert.ok(!h.calls.some(c=>c.kind==='fund'));
});
test('finite end is rechecked against the refreshed default start',async t=>{
  const h=await harness(t);
  await assert.rejects(h.fund({unlimited:false,endsAt:new Date((h.initial+60)*1000).toISOString()}),/End time must be after start time/);
  assert.ok(h.calls.length>0);assert.ok(!h.calls.some(c=>c.kind==='fund'));
});
test('invalid input still fails before preparation transactions',async t=>{
  const h=await harness(t);
  await assert.rejects(h.fund({unlimited:false}),/End time is required/);
  assert.deepEqual(h.calls,[]);
});
