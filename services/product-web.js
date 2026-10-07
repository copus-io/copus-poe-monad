const fs=require('node:fs');
const path=require('node:path');
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml','.woff2':'font/woff2','.ico':'image/x-icon','.wasm':'application/wasm'};
function attachWeb(server,root) {
  if(!fs.existsSync(path.join(root,'index.html')))throw new Error('Built Copus demo UI is missing');
  const patchedScripts=new Map();
  const handlers=server.listeners('request'); server.removeAllListeners('request');
  server.on('request',(req,res)=>{
    res.setHeader('Content-Security-Policy',"connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
    res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('Referrer-Policy','same-origin');
    if(req.url==='/healthz'){res.setHeader('content-type','application/json');return res.end(JSON.stringify({ok:true,network:process.env.POE_DEMO_CHAIN,commit:process.env.POE_RELEASE_COMMIT}));}
    if(process.env.POE_DEMO_PUBLIC_ORIGIN && req.headers.host!==new URL(process.env.POE_DEMO_PUBLIC_ORIGIN).host){res.statusCode=403;return res.end('Unknown host');}
    if(req.url.startsWith('/client/user/time/')) {for(const handler of handlers)handler(req,res);return;}
    if(req.url.startsWith('/client/')){res.statusCode=404;res.setHeader('content-type','application/json');return res.end(JSON.stringify({status:0,data:null,msg:'Not available in this isolated demo'}));}
    if(!['GET','HEAD'].includes(req.method)){res.statusCode=405;return res.end('Method not allowed');}
    let pathname;try{pathname=decodeURIComponent(new URL(req.url,'http://local').pathname);}catch{res.statusCode=400;return res.end();}
    if(pathname==='/demo-route-help.js'){res.setHeader('content-type',types['.js']);res.setHeader('cache-control','no-store');return res.end(req.method==='HEAD'?'':fs.readFileSync(path.join(__dirname,'demo-route-help.js')));}
    let file=path.resolve(root,'.'+pathname);
    if(!file.startsWith(root+path.sep)&&file!==root){res.statusCode=403;return res.end();}
    if(!fs.existsSync(file)||!fs.statSync(file).isFile())file=path.join(root,'index.html');
    res.setHeader('content-type',types[path.extname(file)]||'application/octet-stream');
    res.setHeader('cache-control',file.endsWith('index.html')?'no-store':'public, max-age=3600');
    if(path.extname(file)==='.js') {
      if(!patchedScripts.has(file)) {
        const source=fs.readFileSync(file,'utf8');
        patchedScripts.set(file,require('./demo-ui-patches').patchDemoUi(source));
      }
      res.setHeader('cache-control','no-store');
      return res.end(req.method==='HEAD'?'':patchedScripts.get(file));
    }
    if(req.method==='HEAD')return res.end();
    if(file===path.join(root,'index.html'))return res.end(fs.readFileSync(file,'utf8').replace('</head>','<script defer src="/demo-route-help.js"></script></head>'));
    fs.createReadStream(file).on('error',()=>{if(!res.headersSent)res.statusCode=500;res.end();}).pipe(res);
  });
}
module.exports={attachWeb};
