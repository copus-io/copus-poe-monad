const { expect } = require('chai');
const { DatabaseSync } = require('node:sqlite');
const { createDemo } = require('../services/product-demo');
const { createChain } = require('../services/product-chain');

describe('Real product sponsorship demo', function () {
  this.timeout(120000);
  it('rejects forged identity/origin, funds a v2 campaign, rejects ineligible and duplicate claims, and credits only a confirmed approval', async () => {
    const chain = await createChain();
    const db = new DatabaseSync(':memory:');
    let clock=Date.now();
    const demo = createDemo({ chain,db,now:()=>clock });
    await new Promise((resolve) => demo.server.listen(0,'127.0.0.1',resolve));
    const root = `http://127.0.0.1:${demo.server.address().port}/client/user/time`;
    let cookie = '';
    async function request(route, data, extra = {}) {
      const response = await fetch(root+route,{ method:data === undefined?'GET':'POST',headers:{cookie,origin:'http://localhost:3000','content-type':'application/json',...extra},body:data === undefined?undefined:JSON.stringify(data)});
      if(response.headers.get('set-cookie')) cookie=response.headers.get('set-cookie').split(';')[0];
      return { http:response.status,...await response.json() };
    }
    try {
      expect((await request('/poe/demo/profile',{profile:'eligible'},{origin:'https://evil.example'})).http).to.equal(403);
      const a = await request('/account',undefined,{'oai-authenticated-user-id':'forged'});
      expect(a.data.balanceSeconds).to.equal(0);
      const identity=cookie;
      const published=await request('/sponsorship/publish',{brandName:'Copus creators',title:'Support curious readers',description:'More time to discover independent creators.',coverUrl:'https://www.copus.io/favicon.ico',destinationUrl:'https://www.copus.io',totalTimeMinutes:6000,claimTimeMinutes:30,match:'ALL',mode:'ONGOING',unlimited:true,publicRules:[{type:'work_count',value:1}],hiddenRules:[{type:'followers',value:5}]});
      expect(published.status,published.msg).to.equal(1);
      expect(JSON.stringify(published)).not.to.include('followers');
      const id=Number(published.data.campaignId);
      await request('/poe/demo/profile',{profile:'ineligible'});
      const rejected=await request('/poe/claims',{campaignId:id});
      expect(rejected.status).to.equal(0);
      await request('/poe/demo/profile',{profile:'eligible'});
      const claimed=await request('/poe/claims',{campaignId:id,subjectRef:'attacker',epoch:999});
      expect(claimed.status,claimed.msg).to.equal(1);
      await demo.drain();
      const account=await request('/account');expect(account.data.balanceSeconds).to.equal(1800);
      expect((await request('/poe/claims',{campaignId:id})).status).to.equal(0);
      expect((await request('/account')).data.balanceSeconds).to.equal(1800);
      expect(account.data.sponsorId).to.equal(id);
      expect(account.data.sponsorName).to.equal('Copus creators');
      expect(account.data.pendingIncomeSeconds).to.equal(1800);
      expect((await request('/income/acknowledge',{})).data.pendingIncomeSeconds).to.equal(0);
      const reading=await request('/attention/start',{targetType:'OPUS',targetId:123});
      expect(reading.data.targetType).to.equal('OPUS'); expect(reading.data.targetId).to.equal(123);
      clock+=15000;
      const heartbeat=await request(`/attention/${reading.data.sessionId}/heartbeat`,{});
      expect(heartbeat.data.accruedSeconds).to.equal(15);expect(heartbeat.data.balanceSeconds).to.equal(1800);
      clock+=60000; await request(`/attention/${reading.data.sessionId}/resume`,{});
      clock+=10000;
      expect((await request(`/attention/${reading.data.sessionId}/heartbeat`,{})).data.accruedSeconds).to.equal(25);
      clock+=5000;
      const closed=await request(`/attention/${reading.data.sessionId}/close`,{});
      expect(closed.data.chargedSeconds).to.equal(30);expect(closed.data.balanceSeconds).to.equal(1770);
      const duplicateClose=await request(`/attention/${reading.data.sessionId}/close`,{});
      expect(duplicateClose.data.chargedSeconds).to.equal(0);expect(duplicateClose.data.balanceSeconds).to.equal(1770);
      expect((await request('/ledger')).data.data.some(row=>row.fromUserId===900002&&row.amountSeconds===30)).to.equal(true);
      cookie='poe_demo=00000000000000000000000000000000.'+'0'.repeat(64);
      expect((await request('/account')).data.balanceSeconds).to.equal(0);
      cookie=identity;
      expect((await request('/sponsors')).data[0].poeClaimStatus).to.equal('SETTLED');
    } finally { await demo.drain();await new Promise((resolve)=>demo.server.close(resolve)); db.close(); }
  });
});
