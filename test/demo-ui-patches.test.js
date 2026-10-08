const {test}=require('node:test');
const assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const path=require('node:path');
const {patchDemoUi}=require('../services/demo-ui-patches');
const {validateCampaignSchedule}=require('../services/campaign-schedule');

test('schedule validator supports optional starts and finite or unlimited campaigns',()=>{
  const now=Date.parse('2026-10-07T00:00:00Z');
  assert.deepEqual(validateCampaignSchedule({unlimited:true},now),{startsAt:now/1000+30,endsAt:0});
  assert.deepEqual(validateCampaignSchedule({unlimited:false,endsAt:'2026-10-08T00:00:00Z'},now),{startsAt:now/1000+30,endsAt:Date.parse('2026-10-08T00:00:00Z')/1000});
  assert.throws(()=>validateCampaignSchedule({unlimited:false},now),/End time is required/);
  assert.throws(()=>validateCampaignSchedule({unlimited:false,endsAt:'1970-01-01T00:00:00Z'},now),/End time must be after/);
  assert.throws(()=>validateCampaignSchedule({unlimited:true,startsAt:42},now),/Start time is required/);
});

test('bundled modern and legacy editors receive schedule validation and state labels',()=>{
  const archive=path.join(__dirname,'../demo-ui/copus-ui.tar.gz');
  const paths=execFileSync('tar',['-tzf',archive],{encoding:'utf8'}).split('\n').filter(p=>/\/index[^/]*\.js$/.test(p));
  let patched=0;
  for(const entry of paths) {
    const original=execFileSync('tar',['-xOf',archive,entry],{encoding:'utf8',maxBuffer:20*1024*1024});
    const source=patchDemoUi(original);
    if(source===original)continue;
    patched++;
    assert.ok(source.includes('poeScheduleStatus==="SCHEDULED"'));
    assert.ok(source.includes('poeScheduleStatus==="ENDED"'));
    assert.ok(source.includes('name:"endsAt",dependencies:["startsAt","unlimited"],rules:'));
    assert.ok(source.includes('name:"startsAt",rules:'));
    // Parse the patched source using the host JS parser without executing the UI.
    execFileSync(process.execPath,['--input-type=module','--check'],{input:source,maxBuffer:1024*1024});
  }
  assert.equal(patched,2,'both the modern and legacy main bundles must be patched');
  assert.throws(()=>patchDemoUi('name:"endsAt",label:'),/hook changed/);
});
