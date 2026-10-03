// Product-facing hackathon API. Real proofs/transactions, isolated demo identities
// and ledger. Never points at the Copus production settlement endpoint.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { prepareV2Campaign } = require('../lib/policy-v2-source');
const { normalizePolicy, normalizeReceipt, matches } = require('../lib/poe-v2');
const { createChain } = require('./product-chain');

function fixture(secret, policy, visited = false, profile = 'eligible') {
  // Fixed issuer fixtures, not thresholds copied from the advertiser's input.
  const values = { active_days: 86400, work_count: 2, comment_count: 4, space_count: 1,
    time_spent: 7200, followers: 10, space_membership: 1, viewed_work_keyword: 1, following_author: 1, brand_visit: visited ? 1 : 0 };
  return { subjectSecret: secret, eventCount: profile === 'ineligible' ? '0' : '4',
    totalDwellSeconds: profile === 'ineligible' ? '0' : '145', observedAt: String(Math.floor(Date.now() / 1000)),
    receiptNonce: '77', facts: policy.rules.map((rule) => String(profile === 'ineligible' ? 0 : values[rule.type])) };
}
function publicDraft(draft) { const { hiddenRules, ...visible } = draft; return { ...visible, hiddenRuleCount: hiddenRules?.length || 0 }; }
function createDemo({ chain, db, secret = crypto.randomBytes(32), origin = process.env.POE_DEMO_PUBLIC_ORIGIN || 'http://localhost:3000', now = Date.now }) {
  const publicMode = new URL(origin).hostname !== 'localhost' && new URL(origin).hostname !== '127.0.0.1';
  if (publicMode && new URL(origin).protocol !== 'https:') throw new Error('Public demo requires HTTPS');
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS demo_campaigns(id TEXT PRIMARY KEY, owner TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS demo_claims(subject TEXT NOT NULL, campaign TEXT NOT NULL, epoch TEXT NOT NULL,
      status TEXT NOT NULL, tx TEXT, nullifier TEXT, event_key TEXT, seconds INTEGER NOT NULL DEFAULT 0, error TEXT,
      PRIMARY KEY(subject,campaign,epoch));
    CREATE TABLE IF NOT EXISTS demo_visits(subject TEXT NOT NULL,campaign TEXT NOT NULL,PRIMARY KEY(subject,campaign));
    CREATE TABLE IF NOT EXISTS demo_sessions(id TEXT PRIMARY KEY, profile TEXT NOT NULL DEFAULT 'eligible');
    CREATE TABLE IF NOT EXISTS demo_drafts(subject TEXT PRIMARY KEY,data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS demo_views(id TEXT PRIMARY KEY,subject TEXT NOT NULL,campaign TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS demo_income_ack(subject TEXT PRIMARY KEY,seconds INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS demo_limits(scope TEXT PRIMARY KEY,started INTEGER NOT NULL,used INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS demo_attention(id TEXT PRIMARY KEY,subject TEXT NOT NULL,started INTEGER NOT NULL,last_seen INTEGER NOT NULL,charged INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'ACTIVE');`);
  const attentionColumns = new Set(db.prepare('PRAGMA table_info(demo_attention)').all().map((r)=>r.name));
  for (const [column, definition] of [['accrued','INTEGER NOT NULL DEFAULT 0'],['target_type',"TEXT NOT NULL DEFAULT 'PLATFORM'"],['target_id','INTEGER'],['target_title','TEXT']]) { if (!attentionColumns.has(column)) db.exec(`ALTER TABLE demo_attention ADD COLUMN ${column} ${definition}`); }
  const claimColumns = new Set(db.prepare('PRAGMA table_info(demo_claims)').all().map((r)=>r.name));
  if (!claimColumns.has('expires_at_block')) db.exec('ALTER TABLE demo_claims ADD COLUMN expires_at_block INTEGER');
  if (!claimColumns.has('nullifier')) db.exec('ALTER TABLE demo_claims ADD COLUMN nullifier TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS demo_event_unique ON demo_claims(event_key) WHERE event_key IS NOT NULL');
  let queue = Promise.resolve();
  const serial = (fn) => { const result = queue.then(fn); queue = result.catch(() => {}); return result; };
  const jobs = new Set();
  const network = chain.deployment?.programId ? 'solana-devnet' : chain.deployment?.chainId===10143 ? 'monad-testnet' : 'base-sepolia';
  const campaigns = () => db.prepare('SELECT owner,data FROM demo_campaigns ORDER BY rowid DESC').all().map((r) => ({ owner: r.owner, ...JSON.parse(r.data) }));
  const mac = (id) => crypto.createHmac('sha256', secret).update(id).digest('hex');
  function session(req, res) {
    const cookie = /(?:^|;\s*)poe_demo=([a-f0-9]{32})\.([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '');
    let id;
    if (cookie && crypto.timingSafeEqual(Buffer.from(cookie[2], 'hex'), Buffer.from(mac(cookie[1]), 'hex'))) id = cookie[1];
    else {
      id = crypto.randomBytes(16).toString('hex');
      res.setHeader('set-cookie', `poe_demo=${id}.${mac(id)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${publicMode ? '; Secure' : ''}`);
    }
    db.prepare('INSERT OR IGNORE INTO demo_sessions(id) VALUES(?)').run(id);
    return id;
  }
  function receiptFor(subject, campaign) {
    const key = crypto.createHmac('sha256', secret).update(`receipt:${subject}`).digest('hex').slice(0, 62);
    const visited = Boolean(db.prepare('SELECT 1 FROM demo_visits WHERE subject=? AND campaign=?').get(subject, campaign.id));
    const profile = db.prepare('SELECT profile FROM demo_sessions WHERE id=?').get(subject)?.profile;
    return fixture(BigInt(`0x${key}`).toString(), campaign.policy, visited, profile);
  }
  const eligible = (subject, campaign) => {
    const policy = normalizePolicy(campaign.policy);
    return matches(normalizeReceipt(receiptFor(subject, campaign), policy), policy)
      && (campaign.draft.mode !== 'RETROSPECTIVE' || campaign.owner === subject);
  };
  function account(subject) {
    const earned = db.prepare("SELECT COALESCE(SUM(seconds),0) total FROM demo_claims WHERE subject=? AND status='SETTLED'").get(subject).total;
    const spent = db.prepare('SELECT COALESCE(SUM(charged),0) total FROM demo_attention WHERE subject=?').get(subject).total;
    const total = earned - spent;
    const last = db.prepare("SELECT campaign FROM demo_claims WHERE subject=? AND status='SETTLED' ORDER BY rowid DESC LIMIT 1").get(subject);
    const activeSponsor = last && campaigns().find((c)=>c.id===last.campaign);
    const acknowledged = db.prepare('SELECT seconds FROM demo_income_ack WHERE subject=?').get(subject)?.seconds || 0;
    return { balanceSeconds: total, lifetimeEarnedSeconds: earned, lifetimeClaimedSeconds: earned,
      lifetimeSpentSeconds: spent, pendingIncomeSeconds: Math.max(0,earned-acknowledged), sponsorName: activeSponsor?.draft.brandName || '', sponsorId: activeSponsor ? Number(activeSponsor.id) : 0 };
  }
  const sponsor = (subject, c) => {
    const epoch = c.period ? Math.floor(Date.now() / 1000 / c.period) : 0;
    const claim = db.prepare('SELECT status,tx,error FROM demo_claims WHERE subject=? AND campaign=? AND epoch=?').get(subject, c.id, String(epoch));
    const requirements = c.draft.publicRules.map((rule, index) => {
      const rulePolicy = { ...c.policy, match: 'ALL', rules: [c.policy.rules[index]] };
      const raw = receiptFor(subject, c);
      return { code: rule.type === 'brand_visit' ? 'Open the brand link' : `${rule.type}: ${rule.value}`, met: matches(normalizeReceipt({ ...raw, facts: [raw.facts[index]] }, normalizePolicy(rulePolicy)), normalizePolicy(rulePolicy)) };
    });
    return { id: Number(c.id), slug: `poe-demo-${c.id}`, name: c.draft.brandName,
      title: c.draft.title, description: c.draft.description, coverUrl: c.draft.coverUrl,
      linkUrl: c.draft.destinationUrl, linkLabel: 'Visit sponsor', claimSeconds: c.draft.claimTimeMinutes * 60,
      claimantCount: db.prepare("SELECT COUNT(*) total FROM demo_claims WHERE campaign=? AND status='SETTLED'").get(c.id).total,
      eligible: eligible(subject, c) && (!claim || claim.status === 'EXPIRED') && Date.now() / 1000 >= c.startsAt,
      poeCampaignId: Number(c.id), poeMatch: c.draft.match, poeClaimStatus: claim?.status,
      poeTransactionUrl: claim?.tx ? chain.link(claim.tx) : null, poeChain: chain.label,
      requirements: requirements.length ? requirements : [{ code: 'Issuer-approved experience', met: eligible(subject, c) }],
      poeHasHiddenConditions: c.draft.hiddenRules.length > 0, poeClaimError: claim?.error };
  };
  function ledger(subject) {
    const credits = db.prepare("SELECT rowid id,campaign,seconds,tx FROM demo_claims WHERE subject=? AND status='SETTLED' ORDER BY rowid DESC").all(subject).map((r) => ({ id:r.id,
      fromUserId:900001,targetUserId:900002,amountSeconds:r.seconds,targetType:'SPONSOR',triggerType:'POE_SPONSOR',createTime:new Date().toISOString(),
      fromUsername:campaigns().find((c)=>c.id===r.campaign)?.draft.brandName || 'Sponsor',targetUsername:'Demo reader',targetTitle:'Sponsored TIME',entryCount:1 }));
    const debits = db.prepare('SELECT rowid id,charged,target_type,target_id,target_title,last_seen FROM demo_attention WHERE subject=? AND charged>0 ORDER BY rowid DESC').all(subject).map((r)=>({id:1000000+r.id,
      fromUserId:900002,targetUserId:900003,amountSeconds:r.charged,targetType:r.target_type,targetId:r.target_id,triggerType:'READING',createTime:new Date(r.last_seen).toISOString(),
      fromUsername:'Demo reader',targetUsername:'Demo creator',targetTitle:r.target_title || 'Reading and exploring',entryCount:1 }));
    return [...debits,...credits];
  }
  function reserveOperation(subject, kind) {
    if (!publicMode) return;
    const limits = [[`${kind}:global`,kind==='fund'?24:100,86400000],[`${kind}:${subject}`,kind==='fund'?2:12,3600000]];
    const at=now();
    for(const [scope,max,window]of limits){ const row=db.prepare('SELECT * FROM demo_limits WHERE scope=?').get(scope); if(row && at-row.started<window && row.used>=max)throw new Error('Demo transaction limit reached. Please try again later.'); }
    for(const [scope,,window]of limits){const row=db.prepare('SELECT * FROM demo_limits WHERE scope=?').get(scope); if(!row || at-row.started>=window) db.prepare('INSERT INTO demo_limits VALUES(?,?,1) ON CONFLICT(scope) DO UPDATE SET started=excluded.started,used=1').run(scope,at); else db.prepare('UPDATE demo_limits SET used=used+1 WHERE scope=?').run(scope);}
  }
  async function body(req) { let text = ''; for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > 20_000) throw new Error('request too large'); } return JSON.parse(text || '{}'); }
  const server = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store');
    const url = new URL(req.url, 'http://localhost');
    const reply = (data, status = 1, msg = '') => res.end(JSON.stringify({ status, data, msg }));
    // Bind loopback only, restrict Host, and preserve original Origin at the Vite
    // proxy. Credentials and issuer facts cannot be selected by the browser.
    if (publicMode ? req.headers.host !== new URL(origin).host : !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || '')) { res.statusCode = 403; return reply(null, 0, 'local demo only'); }
    if (req.method !== 'GET' && ![origin, origin.replace('localhost', '127.0.0.1')].includes(req.headers.origin)) { res.statusCode = 403; return reply(null, 0, 'untrusted origin'); }
    const subject = session(req, res);
    try {
      const base = '/client/user/time';
      if (url.pathname === `${base}/poe/demo` && req.method === 'GET') return reply({ chain: chain.label, live: chain.live, fixture: true, ledger: 'isolated demo', profile: db.prepare('SELECT profile FROM demo_sessions WHERE id=?').get(subject).profile });
      if (url.pathname === `${base}/poe/demo/profile` && req.method === 'POST') {
        const input = await body(req); if (!['eligible','ineligible'].includes(input.profile)) throw new Error('invalid demo profile');
        db.prepare('UPDATE demo_sessions SET profile=? WHERE id=?').run(input.profile, subject); return reply(true);
      }
      if (url.pathname === `${base}/sponsorship/access`) return reply({ status: 'APPROVED', brand: 'Copus creator' });
      if (url.pathname === `${base}/sponsorship/dashboard`) return reply({ draft: JSON.parse(db.prepare('SELECT data FROM demo_drafts WHERE subject=?').get(subject)?.data || JSON.stringify({network,brandName:'Copus Creators',title:'Give curiosity another 30 minutes',description:'Discover independent creators. Prove you qualify without sharing your private reading history.',coverUrl:'/assets/og-copus-v2.png',destinationUrl:'https://www.copus.io',totalTimeHours:100,claimTimeMinutes:30,unlimited:true,match:'ALL',mode:'ONGOING',publicRules:[{type:'work_count',value:1}],hiddenRules:[]})),
        paymentsEnabled: true, publishingEnabled: true, poeEnabled: true,
        sponsors: campaigns().filter((c) => c.owner === subject).map((c) => ({ ...sponsor(subject,c), state: 1 })) });
      if (url.pathname === `${base}/sponsorship/draft` && req.method === 'POST') {
        const draft = await body(req); db.prepare('INSERT INTO demo_drafts VALUES(?,?) ON CONFLICT(subject) DO UPDATE SET data=excluded.data').run(subject, JSON.stringify(draft)); return reply(true);
      }
      if (url.pathname === `${base}/sponsorship/publish` && req.method === 'POST') {
        const raw = await body(req);
        const draft = { ...raw, network, publicRules: raw.publicRules || [], hiddenRules: raw.hiddenRules || [], match: raw.match || 'ALL', mode: raw.mode || 'ONGOING' };
        for (const key of ['title','brandName','description','coverUrl','destinationUrl']) if (typeof draft[key] !== 'string' || !draft[key].trim() || draft[key].length > 2048) throw new Error(`invalid ${key}`);
        if (!['ONGOING','RETROSPECTIVE'].includes(draft.mode)) throw new Error('invalid campaign mode');
        if (new URL(draft.destinationUrl).protocol !== 'https:') throw new Error('campaign link must use HTTPS');
        if (![draft.totalTimeMinutes, draft.claimTimeMinutes].every((n) => Number.isSafeInteger(n) && n >= 30 && n <= 10_000_000)
          || draft.totalTimeMinutes % draft.claimTimeMinutes) throw new Error('TIME budget must be divisible by allocation');
        if (draft.mode === 'RETROSPECTIVE' && draft.publicRules.some((r) => r.type === 'brand_visit')) throw new Error('brand visit requires ongoing mode');
        const prepared = await prepareV2Campaign({ ...draft, minEvents: 3, minDwellSeconds: 90, notBefore: Math.floor(Date.now()/1000)-30*86400 });
        const snapshotReceipt = receiptFor(subject, { id: 'new', policy: prepared.provingPolicy });
        const result = await serial(() => { reserveOperation(subject,'fund'); return chain.fund(draft, prepared, snapshotReceipt); });
        const campaign = { ...result, owner: subject, snapshotReceipt, draft, policy: prepared.provingPolicy, ruleHash: prepared.ruleHash, manifestHash: prepared.manifestHash };
        db.prepare('INSERT INTO demo_campaigns VALUES(?,?,?)').run(campaign.id, subject, JSON.stringify(campaign));
        return reply({ campaignId: campaign.id, transactionHash: result.transactionHash, transactionUrl: chain.link(result.transactionHash), draft: publicDraft(draft) });
      }
      if (url.pathname === `${base}/sponsors`) return reply(campaigns().map((c) => sponsor(subject, c)));
      if (url.pathname === `${base}/poe/claims` && req.method === 'POST') {
        const input = await body(req);
        const campaign = campaigns().find((c) => c.id === String(input.campaignId));
        if (!campaign || !eligible(subject,campaign)) throw new Error('Not eligible for this campaign');
        const epoch = campaign.period ? await chain.epoch(campaign) : 0;
        const existing = db.prepare('SELECT status,tx FROM demo_claims WHERE subject=? AND campaign=? AND epoch=?').get(subject,campaign.id,String(epoch));
        if (existing && existing.status !== 'EXPIRED') throw new Error('Already claimed or awaiting confirmation');
        db.prepare("INSERT INTO demo_claims(subject,campaign,epoch,status) VALUES(?,?,?,'PENDING') ON CONFLICT(subject,campaign,epoch) DO UPDATE SET status='PENDING',error=NULL").run(subject,campaign.id,String(epoch));
        let result;
        try { result = await serial(() => { reserveOperation(subject,'claim'); return chain.claim(campaign,campaign.draft.mode === 'RETROSPECTIVE' ? campaign.snapshotReceipt : receiptFor(subject,campaign), epoch); }); }
        catch (error) { db.prepare("UPDATE demo_claims SET status='EXPIRED',error=? WHERE subject=? AND campaign=? AND epoch=?").run(error.shortMessage || error.message,subject,campaign.id,String(epoch)); throw error; }
        if (String(result.epoch) !== String(epoch)) throw new Error('chain epoch changed during proving; retry');
        db.prepare('UPDATE demo_claims SET tx=?,nullifier=?,expires_at_block=? WHERE subject=? AND campaign=? AND epoch=?').run(result.transactionHash,result.nullifier,result.expiresAtBlock || null,subject,campaign.id,String(epoch));
        // UI receives a pending transaction. Only a canonical approval may credit.
        const job = result.finalize().then(({ eventKey,timeSeconds }) => {
          db.prepare("UPDATE demo_claims SET status='SETTLED',event_key=?,seconds=? WHERE subject=? AND campaign=? AND epoch=? AND status='PENDING'").run(eventKey,timeSeconds,subject,campaign.id,String(epoch));
        }).catch((error) => { db.prepare("UPDATE demo_claims SET error=? WHERE subject=? AND campaign=? AND epoch=?").run(error.message,subject,campaign.id,String(epoch)); });
        jobs.add(job); job.finally(() => jobs.delete(job));
        return reply({ transactionHash: result.transactionHash, epoch: String(epoch), transactionUrl: chain.link(result.transactionHash) });
      }
      if (url.pathname === `${base}/income/acknowledge` && req.method==='POST') { const current=account(subject); db.prepare('INSERT INTO demo_income_ack VALUES(?,?) ON CONFLICT(subject) DO UPDATE SET seconds=excluded.seconds').run(subject,current.lifetimeEarnedSeconds); return reply(account(subject)); }
      if (url.pathname === `${base}/account`) return reply(account(subject));
      if (url.pathname === `${base}/ledger/top-sponsors`) return reply([]);
      if (url.pathname.startsWith(`${base}/ledger`)) { const list = ledger(subject); return reply({ data:list, totalRecords:list.length, pageIndex:1,pageSize:30 }); }
      if (url.pathname === `${base}/poe/activity`) return reply(true);
      if (/\/sponsors\/\d+\/views$/.test(url.pathname)) {
        const viewId=crypto.randomUUID(); const id=/\/sponsors\/(\d+)/.exec(url.pathname)[1];
        db.prepare('INSERT INTO demo_views VALUES(?,?,?)').run(viewId,subject,id);
        return reply({viewId,status:'ACTIVE',serverStartedAt:Date.now(),visibleMs:0,dwellMs:0,viewable:true,nonce:'demo',nextSequence:1});
      }
      if (/\/sponsors\/views\/[^/]+\/click$/.test(url.pathname)) {
        const viewId=url.pathname.split('/').at(-2);
        const view=db.prepare('SELECT campaign FROM demo_views WHERE id=? AND subject=?').get(viewId,subject);
        if(!view)throw new Error('unknown sponsor view');
        db.prepare('INSERT OR IGNORE INTO demo_visits VALUES(?,?)').run(subject,view.campaign); return reply(true);
      }
      if (/\/sponsors\/\d+\/brand-visit$/.test(url.pathname) || /\/sponsors\/\d+\/.*cta/.test(url.pathname)) {
        const id = /\/sponsors\/(\d+)/.exec(url.pathname)[1]; db.prepare('INSERT OR IGNORE INTO demo_visits VALUES(?,?)').run(subject,id); return reply(true);
      }
      if (/\/views\/|\/panels|\/brand-visit/.test(url.pathname)) return reply(true);
      if (url.pathname === `${base}/attention/start` && req.method==='POST') {
        const input=await body(req); const id=crypto.randomUUID(), at=now();
        if(!['PLATFORM','SPACE','OPUS','COMMENT','INLINE_COMMENT','USER','DM'].includes(input.targetType)) throw new Error('invalid reading target');
        db.prepare('INSERT INTO demo_attention(id,subject,started,last_seen,target_type,target_id,target_title) VALUES(?,?,?,?,?,?,?)').run(id,subject,at,at,input.targetType,input.targetId || null,'Reading and exploring');
        return reply({sessionId:id,status:'ACTIVE',targetType:input.targetType,targetId:input.targetId,targetUserId:900003,serverStartedAt:at,accruedSeconds:0,balanceSeconds:account(subject).balanceSeconds});
      }
      if (url.pathname.includes('/attention/') && req.method==='POST') {
        const id=url.pathname.split('/').at(-2);
        const row=db.prepare('SELECT * FROM demo_attention WHERE id=? AND subject=?').get(id,subject);
        if(!row)throw new Error('unknown attention session');
        const closing=url.pathname.endsWith('/close'), resuming=url.pathname.endsWith('/resume');
        if(!closing&&!resuming&&!url.pathname.endsWith('/heartbeat'))throw new Error('invalid attention action');
        const balance=account(subject).balanceSeconds;
        const elapsed=row.status==='ACTIVE'&&!resuming?Math.max(0,Math.min(30,Math.floor((now()-row.last_seen)/1000))):0;
        const accrued=Math.min(balance,row.accrued+elapsed);
        const charged=closing&&row.status==='ACTIVE'?accrued:0;
        db.prepare('UPDATE demo_attention SET accrued=?,charged=charged+?,last_seen=?,status=? WHERE id=?').run(closing?0:accrued,charged,now(),closing?'CLOSED':row.status,id);
        return reply({sessionId:id,status:closing?'CLOSED':row.status,targetType:row.target_type,targetId:row.target_id,targetUserId:900003,serverStartedAt:row.started,
          accruedSeconds:closing?0:accrued,chargedSeconds:charged,balanceSeconds:account(subject).balanceSeconds,duplicate:row.status==='CLOSED',insufficientBalance:accrued>=balance});
      }
      res.statusCode = 404; return reply(null,0,'unsupported demo endpoint');
    } catch(error) { return reply(null,0,error.shortMessage || error.message); }
  });
  return { server, drain: () => Promise.all([...jobs]), account, campaigns,
    async reconcile() {
      for (const row of db.prepare("SELECT * FROM demo_claims WHERE status='PENDING' AND tx IS NOT NULL").all()) {
        const campaign=campaigns().find((c)=>c.id===row.campaign);
        if(!campaign || !chain.status)continue;
        try {
          const outcome=await chain.status(campaign,row);
          if(outcome?.eventKey)db.prepare("UPDATE demo_claims SET status='SETTLED',event_key=?,seconds=?,error=NULL WHERE subject=? AND campaign=? AND epoch=? AND status='PENDING'").run(outcome.eventKey,outcome.timeSeconds,row.subject,row.campaign,row.epoch);
          if(outcome?.failed)db.prepare("UPDATE demo_claims SET status='EXPIRED',error=? WHERE subject=? AND campaign=? AND epoch=?").run(outcome.failed,row.subject,row.campaign,row.epoch);
        } catch(error) { /* RPC errors cannot become credits or trigger resubmission. */ }
      }
    } };
}
async function main() {
  const dir = process.env.POE_DEMO_DATA || fs.mkdtempSync(path.join(require('node:os').tmpdir(),'copus-poe-product-'));
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const file = path.join(dir,'demo.db');
  if (!fs.existsSync(file)) fs.closeSync(fs.openSync(file,'wx',0o600));
  fs.chmodSync(file,0o600);
  const secretFile = path.join(dir,'session.key');
  if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile,crypto.randomBytes(32),{flag:'wx',mode:0o600});
  if (fs.statSync(secretFile).mode & 0o077) throw new Error('session key must be owner-only');
  const chain = await createChain();
  const demo = createDemo({chain,db:new DatabaseSync(file),secret:fs.readFileSync(secretFile)});
  await demo.reconcile();
  let reconciling=false;
  const reconcileTimer=setInterval(async()=>{if(reconciling)return;reconciling=true;try{await demo.reconcile();}finally{reconciling=false;}},5000);
  reconcileTimer.unref();
  if (process.env.POE_WEB_ROOT) { const {attachWeb}=require('./product-web'); attachWeb(demo.server,path.resolve(process.env.POE_WEB_ROOT)); }
  demo.server.listen(Number(process.env.POE_DEMO_PORT || 8792),process.env.POE_DEMO_HOST || '127.0.0.1',()=>console.log(`Copus product demo API ready · ${chain.label} · isolated fixture ledger`));
}
if(require.main===module)main().catch((error)=>{console.error(error.message);process.exitCode=1;});
module.exports={createDemo,fixture,main};
