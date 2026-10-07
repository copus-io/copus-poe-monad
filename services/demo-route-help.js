// The bundled review UI exposes Create navigation, but has no publishing backend.
// Keep this boundary visible for both direct loads and client-side navigation.
(() => {
  const panel = document.createElement('section');
  panel.id = 'demo-create-help';
  panel.setAttribute('aria-labelledby', 'demo-create-title');
  panel.innerHTML = `<style>
    #demo-create-help{position:fixed;inset:24px 24px 90px 116px;z-index:20;overflow:auto;background:#f8f9fb;display:grid;place-items:center;font-family:system-ui,sans-serif;color:#252525}
    #demo-create-help[hidden]{display:none}
    #demo-create-help .demo-help-card{box-sizing:border-box;width:100%;max-width:540px;padding:32px;border:1px solid #e7e7e7;border-radius:20px;background:white}
    #demo-create-help h1{font-size:26px;line-height:1.25;margin:12px 0 16px}
    #demo-create-help p{font-size:15px;line-height:1.7;color:#666}
    #demo-create-help .demo-label{color:#d84c26;font-size:12px;letter-spacing:.08em;font-weight:600}
    #demo-create-help nav{display:flex;flex-direction:column;gap:12px;margin-top:24px}
    #demo-create-help a{display:block;text-align:center;text-decoration:none;border:1px solid #e4e4e4;border-radius:24px;padding:12px 16px;color:#333;font-size:15px}
    #demo-create-help a:first-child{background:#df4c24;border-color:#df4c24;color:white}
    @media(max-width:767px){#demo-create-help{inset:16px 16px 90px}#demo-create-help .demo-help-card{padding:24px}#demo-create-help h1{font-size:24px}}
  </style><div class="demo-help-card"><span class="demo-label">COPUS PRODUCT DEMO</span><h1 id="demo-create-title">Try a TIME sponsorship</h1><p>Work publishing is not available in this demo. You can create a sponsorship, claim TIME and inspect your TIME activity.</p><nav aria-label="Demo activities"><a href="/time-sponsors?sponsorshipDemo=1">Create a sponsorship</a><a href="/time-sponsors">Claim TIME</a><a href="/time-ledger">View TIME activity</a></nav></div>`;
  document.body.append(panel);
  const render = () => { panel.hidden = location.pathname.replace(/\/$/, '') !== '/create'; };
  for (const method of ['pushState', 'replaceState']) {
    const original = history[method];
    history[method] = function (...args) { const result = original.apply(this, args); render(); return result; };
  }
  addEventListener('popstate', render);
  render();
})();
