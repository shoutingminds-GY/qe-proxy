const http = require('http');
const https = require('https');
const PORT = process.env.PORT || 3000;

function req(options, body) {
  return new Promise((resolve, reject) => {
    const r = https.request(options, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch(e) { resolve({ status: res.statusCode, body: { raw: d } }); }
      });
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

http.createServer(async (request, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (request.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  if (request.method === 'GET') {
    try {
      const r = await req({ hostname: 'api.ipify.org', path: '/?format=json', method: 'GET', headers: { 'Accept': 'application/json' } });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', outbound_ip: r.body.ip }));
    } catch(e) { res.writeHead(200); res.end(JSON.stringify({ status: 'ok', error: e.message })); }
    return;
  }

  if (request.method !== 'POST') { res.writeHead(405); res.end(JSON.stringify({ error: 'Method not allowed' })); return; }

  let body = '';
  request.on('data', c => body += c);
  request.on('end', async () => {
    try {
      const { action, token, payload } = JSON.parse(body);
      if (!token) { res.writeHead(400); res.end(JSON.stringify({ error: 'No token' })); return; }

      const h = { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json', 'Content-Type': 'application/json' };
      let result;

      if (action === 'place_order') {
        const ob = JSON.stringify(payload);
        result = await req({ hostname: 'api.upstox.com', path: '/v2/order/place', method: 'POST', headers: { ...h, 'Content-Length': Buffer.byteLength(ob) } }, ob);

      } else if (action === 'option_chain') {
        const { instrument_key, expiry_date } = payload;
        const qs = expiry_date ? `instrument_key=${encodeURIComponent(instrument_key)}&expiry_date=${expiry_date}` : `instrument_key=${encodeURIComponent(instrument_key)}`;
        result = await req({ hostname: 'api.upstox.com', path: `/v2/option/contract?${qs}`, method: 'GET', headers: h });

      } else if (action === 'fund_margin') {
        // Try 4 endpoints until one works
        const endpoints = [
          '/v2/user/fund-margin?segment=FO',
          '/v2/user/fund-margin?segment=SEC', 
          '/v3/user/fund-margin',
          '/v2/user/fund-margin'
        ];
        for (const path of endpoints) {
          result = await req({ hostname: 'api.upstox.com', path, method: 'GET', headers: h });
          if (result.status === 200) break;
        }

      } else {
        res.writeHead(400); res.end(JSON.stringify({ error: 'Unknown action' })); return;
      }

      res.writeHead(result.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.body));
    } catch(err) {
      res.writeHead(500); res.end(JSON.stringify({ error: err.message }));
    }
  });
}).listen(PORT, () => console.log(`QE Proxy on port ${PORT}`));
