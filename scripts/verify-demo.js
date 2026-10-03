const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
for(const [dir,file]of [['demo-ui','copus-ui.tar.gz'],['program-binary','copus_poe_solana.so']]){
  const manifestFile=path.join(root,dir,'manifest.json');if(!fs.existsSync(manifestFile))continue;
  const manifest=JSON.parse(fs.readFileSync(manifestFile));const actual=crypto.createHash('sha256').update(fs.readFileSync(path.join(root,dir,file))).digest('hex');
  if(actual!==manifest.sha256)throw Error(`${dir} checksum mismatch`);
  if(dir==='demo-ui'){
    if(!/^[a-f0-9]{40}$/.test(manifest.frontendCommit)||manifest.buildMode!=='poe-demo')throw Error('Missing exact frontend provenance');
    const list=spawnSync('tar',['-tzf',path.join(root,dir,file)],{encoding:'utf8'});if(list.status!==0||!list.stdout.split('\n').includes('index.html'))throw Error('Built UI missing index.html');
    if(list.stdout.split('\n').some(n=>n.startsWith('/')||n.split('/').includes('..')||n.endsWith('.apk')))throw Error('Unexpected UI archive entry');
  }
  console.log(`${dir}: checksum and provenance verified`);
}
