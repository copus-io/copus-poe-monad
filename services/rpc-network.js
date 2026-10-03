const { fetch, ProxyAgent } = require('undici');

function rpcFetch() {
  // Explicit proxy for RPC only; loopback requests are never sent through it.
  const proxy = process.env.POE_RPC_PROXY;
  const dispatcher = proxy ? new ProxyAgent(proxy) : undefined;
  return (url, options = {}) => fetch(url, { ...options, ...(dispatcher && { dispatcher }) });
}
function evmRequest(url, ethers) {
  const request = new ethers.FetchRequest(url);
  if (process.env.POE_RPC_PROXY) {
    const send = rpcFetch();
    request.getUrlFunc = async (req, signal) => {
      const abort = new AbortController();
      signal?.addListener(() => abort.abort());
      const timer = setTimeout(() => abort.abort(), req.timeout);
      try {
        const response = await send(req.url, { method:req.method, headers:req.headers, body:req.body, signal:abort.signal });
        return { statusCode:response.status, statusMessage:response.statusText, headers:Object.fromEntries(response.headers), body:new Uint8Array(await response.arrayBuffer()) };
      } finally {clearTimeout(timer);}
    };
  }
  return request;
}
module.exports={rpcFetch,evmRequest};
