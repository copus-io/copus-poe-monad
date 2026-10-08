const {test}=require('node:test');
const assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {createDemo}=require('../services/product-demo');

async function harness(t, db=new DatabaseSync(':memory:')) {
  let clock=Date.parse('2026-10-07T00:00:00Z');
  const chain={label:'ledger test',deployment:{programId:'test'},link:()=>null,
    claim:async c=>({transactionHash:`tx-${c.id}`,epoch:'0',nullifier:'test',finalize:async()=>({eventKey:`event-${c.id}`,timeSeconds:1800})}),
    status:async(c,row)=>({eventKey:`event-${row.tx}`,timeSeconds:1800})};
  const demo=createDemo({chain,db,now:()=>clock});
  await new Promise(r=>demo.server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await demo.drain();await new Promise(r=>demo.server.close(r));db.close();});
  const root=`http://127.0.0.1:${demo.server.address().port}/client/user/time`;
  const init=await fetch(root+'/account');
  const cookie=init.headers.get('set-cookie').split(';')[0];
  const subject=/poe_demo=([a-f0-9]+)/.exec(cookie)[1];
  async function request(route,body,identity=cookie) {
    const r=await fetch(root+route,{method:body===undefined?'GET':'POST',headers:{cookie:identity,origin:'http://localhost:3000','content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    return r.json();
  }
  function campaign(id,name) {
    db.prepare('INSERT INTO demo_campaigns VALUES(?,?,?)').run(id,subject,JSON.stringify({id,startsAt:0,period:0,policy:{match:'ALL',minEvents:'0',minDwellSeconds:'0',notBefore:'0',rules:[]},draft:{brandName:name,title:`${name} campaign`,mode:'ONGOING',publicRules:[],hiddenRules:[],claimTimeMinutes:30}}));
  }
  return {db,demo,chain,request,subject,campaign,advance:n=>clock+=n,now:()=>clock};
}

test('sponsor application opens access immediately for only the signed demo session',async t=>{
  const h=await harness(t);
  assert.equal((await h.request('/sponsorship/access')).data.status,'NONE');
  assert.equal((await h.request('/sponsorship/apply',{})).data.status,'APPROVED');
  assert.equal((await h.request('/sponsorship/access')).data.status,'APPROVED');
  assert.equal((await h.request('/sponsorship/apply',{})).data.status,'APPROVED');
  assert.equal((await h.request('/sponsorship/access',undefined,'')).data.status,'NONE');
  assert.equal((await h.request('/sponsorship/dashboard')).data.draft.network,'solana-devnet');
  assert.equal(h.db.prepare('SELECT COUNT(*) n FROM demo_campaigns').get().n,0);
  assert.equal((await h.request('/account')).data.balanceSeconds,0);
});

test('ledger filters before pagination, isolates identities and returns each campaign source',async t=>{
  const h=await harness(t);h.campaign('1','Brand A');h.campaign('2','Brand B');
  const ins=h.db.prepare('INSERT INTO demo_claims(subject,campaign,epoch,status,seconds,settled_at) VALUES(?,?,?,?,?,?)');
  ins.run(h.subject,'1','0','SETTLED',1800,h.now());h.advance(1000);
  ins.run(h.subject,'2','0','SETTLED',1800,h.now());
  ins.run(h.subject,'2','1','PENDING',1800,h.now());
  ins.run('someone-else','1','0','SETTLED',9000,h.now());
  const session=(await h.request('/attention/start',{targetType:'PLATFORM'})).data.sessionId;
  h.advance(12000);await h.request(`/attention/${session}/close`,{});
  const all=(await h.request('/ledger?direction=ALL&merge=true')).data;
  assert.deepEqual(all.data.map(r=>r.direction),['OUT','IN','IN']);assert.equal(all.totalRecords,3);
  const first=(await h.request('/ledger?direction=IN&pageIndex=1&pageSize=1')).data;
  const second=(await h.request('/ledger?direction=IN&pageIndex=2&pageSize=1')).data;
  assert.equal(first.totalRecords,2);assert.equal(second.totalRecords,2);
  assert.equal(first.data[0].sponsorName,'Brand B');assert.equal(second.data[0].fromUsername,'Brand A');
  assert.equal(first.data[0].campaignId,'2');assert.notEqual(first.data[0].id,second.data[0].id);
  assert.equal((await h.request('/ledger?direction=IN&pageIndex=3&pageSize=1')).data.data.length,0);
  const out=(await h.request('/ledger?direction=OUT')).data;
  assert.equal(out.totalRecords,1);assert.equal(out.data[0].amountSeconds,12);
  assert.equal((await h.request('/account')).data.balanceSeconds,3588);
  assert.equal((await h.request('/ledger',undefined,'')).data.totalRecords,0);
  for(const query of ['direction=bad','pageIndex=0','pageSize=-1','pageSize=101','pageIndex=1.5','pageSize=NaN'])assert.equal((await h.request('/ledger?'+query)).status,0,query);
  // A repeat close must not move the expense date or charge again.
  h.advance(60000);await h.request(`/attention/${session}/close`,{});
  assert.deepEqual((await h.request('/ledger?direction=OUT')).data,out);
});

test('normal settlement and reconciliation persist time once; reads never change it',async t=>{
  const h=await harness(t);h.campaign('1','Brand A');h.campaign('2','Brand B');
  assert.equal((await h.request('/poe/claims',{campaignId:'1'})).status,1);
  await h.demo.drain();
  const first=(await h.request('/ledger?direction=IN')).data.data[0];
  assert.equal(first.createTime,new Date(h.now()).toISOString());assert.equal(first.timeSource,'SETTLEMENT');
  h.advance(5000);
  h.db.prepare("INSERT INTO demo_claims(subject,campaign,epoch,status,tx) VALUES(?,?,?,'PENDING',?)").run(h.subject,'2','0','recover');
  await h.demo.reconcile();
  const rows=(await h.request('/ledger')).data.data;
  assert.equal(rows[0].campaignId,'2');assert.equal(rows[0].createTime,new Date(h.now()).toISOString());assert.equal(rows[1].createTime,first.createTime);
  h.advance(60000);await h.demo.reconcile();
  assert.deepEqual((await h.request('/ledger')).data.data,rows);
  assert.equal((await h.request('/poe/claims',{campaignId:'1'})).status,0);
  assert.equal((await h.request('/account')).data.balanceSeconds,3600);
});

test('existing database migrates without inventing legacy claim dates or changing balances',async t=>{
  const db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE demo_claims(subject TEXT,campaign TEXT,epoch TEXT,status TEXT,tx TEXT,event_key TEXT,seconds INTEGER DEFAULT 0,error TEXT,PRIMARY KEY(subject,campaign,epoch));
    CREATE TABLE demo_attention(id TEXT PRIMARY KEY,subject TEXT,started INTEGER,last_seen INTEGER,charged INTEGER DEFAULT 0,status TEXT DEFAULT 'ACTIVE');`);
  db.exec("INSERT INTO demo_attention VALUES('legacy-session','legacy',1000,2000,10,'CLOSED')");
  const h=await harness(t,db);h.campaign('1','Old Brand');
  assert.equal(db.prepare("SELECT closed_at FROM demo_attention WHERE id='legacy-session'").get().closed_at,2000);
  db.prepare("INSERT INTO demo_claims(subject,campaign,epoch,status,seconds) VALUES(?,?,?,'SETTLED',1800)").run(h.subject,'1','0');
  const row=(await h.request('/ledger')).data.data[0];
  assert.equal(row.createTime,null);assert.equal(row.timeSource,'UNKNOWN');
  h.advance(60000);assert.deepEqual((await h.request('/ledger')).data.data[0],row);
  assert.equal((await h.request('/account')).data.balanceSeconds,1800);
});

test('invalid campaign schedules never invoke chain funding',async t=>{
  const h=await harness(t);let calls=0;
  h.chain.fund=async()=>{calls++;throw new Error('unexpected funding');};
  const draft={brandName:'Brand',title:'Dates',description:'Schedule validation',coverUrl:'/cover.png',destinationUrl:'https://example.com',totalTimeMinutes:6000,claimTimeMinutes:30,match:'ALL',mode:'RETROSPECTIVE',publicRules:[],hiddenRules:[]};
  for(const schedule of [
    {unlimited:false},
    {unlimited:false,endsAt:'invalid'},
    {unlimited:true,startsAt:new Date(h.now()-1000).toISOString()},
    {unlimited:false,startsAt:new Date(h.now()+60000).toISOString(),endsAt:new Date(h.now()+60000).toISOString()},
    {unlimited:false,endsAt:new Date(h.now()+10000).toISOString()},
  ]) {
    const r=await h.request('/sponsorship/publish',{...draft,...schedule});
    assert.equal(r.status,0);assert.match(r.msg,/time/i);
  }
  assert.equal(calls,0);assert.equal(h.db.prepare('SELECT COUNT(*) n FROM demo_campaigns').get().n,0);
});

test('scheduled cards become claimable at start; premature and ended claims never reach chain',async t=>{
  const h=await harness(t);h.campaign('1','Future');
  const c=JSON.parse(h.db.prepare('SELECT data FROM demo_campaigns WHERE id=?').get('1').data);
  c.startsAt=Math.floor(h.now()/1000)+60;c.draft.unlimited=false;c.draft.endsAt=new Date(h.now()+120000).toISOString();
  h.db.prepare('UPDATE demo_campaigns SET data=? WHERE id=?').run(JSON.stringify(c),'1');
  let calls=0;h.chain.claim=async()=>{calls++;throw new Error('must not broadcast');};
  let card=(await h.request('/sponsors')).data[0];
  assert.equal(card.poeScheduleStatus,'SCHEDULED');assert.equal(card.eligible,false);
  assert.match((await h.request('/poe/claims',{campaignId:'1'})).msg,/not started/);
  h.advance(60000);card=(await h.request('/sponsors')).data[0];
  assert.equal(card.poeScheduleStatus,'ACTIVE');assert.equal(card.eligible,true);
  h.advance(60000);card=(await h.request('/sponsors')).data[0];
  assert.equal(card.poeScheduleStatus,'ENDED');assert.equal(card.eligible,false);
  assert.match((await h.request('/poe/claims',{campaignId:'1'})).msg,/ended/);
  assert.equal(calls,0);assert.equal(h.db.prepare('SELECT COUNT(*) n FROM demo_claims').get().n,0);
});

test('top sponsors aggregate only the current reader settled credits with stable ties',async t=>{
  const h=await harness(t);h.campaign('1','Small');h.campaign('2','Big');h.campaign('3','Tie');
  assert.deepEqual((await h.request('/ledger/top-sponsors')).data,[]);
  const ins=h.db.prepare('INSERT INTO demo_claims(subject,campaign,epoch,status,seconds) VALUES(?,?,?,?,?)');
  ins.run(h.subject,'1','0','SETTLED',1800);ins.run(h.subject,'2','0','SETTLED',1800);ins.run(h.subject,'2','1','SETTLED',1800);
  ins.run(h.subject,'3','0','SETTLED',1800);ins.run(h.subject,'1','1','PENDING',99000);ins.run(h.subject,'1','2','EXPIRED',99000);
  ins.run('someone-else','1','0','SETTLED',99999);
  const rows=(await h.request('/ledger/top-sponsors')).data;
  assert.deepEqual(rows.map(r=>[r.sourceId,r.name,r.totalSeconds]),[[2,'Big',3600],[1,'Small',1800],[3,'Tie',1800]]);
  assert.ok(rows.every(r=>r.sourceType==='BRAND'));
  assert.deepEqual((await h.request('/ledger/top-sponsors',undefined,'')).data,[]);
});


test('ten minute allocations publish; smaller allocations never reach funding',async t=>{
  const h=await harness(t);let calls=0;
  h.chain.fund=async(draft)=>{calls++;return {id:'100',startsAt:Math.floor(h.now()/1000)+30,period:0,transactionHash:'funding-test'};};
  const draft={brandName:'Brand',title:'Ten minutes',description:'Minimum allocation',coverUrl:'/cover.png',destinationUrl:'https://example.com',totalTimeMinutes:6000,claimTimeMinutes:9,match:'ALL',mode:'ONGOING',unlimited:true,publicRules:[],hiddenRules:[]};
  assert.equal((await h.request('/sponsorship/publish',draft)).status,0);
  assert.equal(calls,0);
  const result=await h.request('/sponsorship/publish',{...draft,claimTimeMinutes:10});
  assert.equal(result.status,1,result.msg);assert.equal(calls,1);
  assert.equal((await h.request('/sponsors')).data[0].claimSeconds,600);
});
