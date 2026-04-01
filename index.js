const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 3000;

function upstoxRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, body: { raw: data } }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // GET - return outbound IP
  if (req.method === 'GET') {
    try {
      const r = await upstoxRequest({ hostname: 'api.ipify.org', path: '/?format=json', method: 'GET', headers: { 'Accept': 'application/json' } });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', outbound_ip: r.body.ip }));
    } catch(e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', error: e.message }));
    }
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    try {
      const { action, token, payload } = JSON.parse(body);
      if (!token) { res.writeHead(400); res.end(JSON.stringify({ error: 'No token' })); return; }

      const authHeaders = {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      };

      let result;

      if (action === 'place_order') {
        const orderBody = JSON.stringify(payload);
        result = await upstoxRequest({
          hostname: 'api.upstox.com',
          path: '/v2/order/place',
          method: 'POST',
          headers: { ...authHeaders, 'Content-Length': Buffer.byteLength(orderBody) }
        }, orderBody);

      } else if (action === 'option_chain') {
        const { instrument_key, expiry_date } = payload;
        const qs = expiry_date
          ? `instrument_key=${encodeURIComponent(instrument_key)}&expiry_date=${expiry_date}`
          : `instrument_key=${encodeURIComponent(instrument_key)}`;
        result = await upstoxRequest({
          hostname: 'api.upstox.com',
          path: `/v2/option/contract?${qs}`,
          method: 'GET',
          headers: authHeaders
        });

      } else if (action === 'fund_margin') {
        // Try segment=FO first (F&O accounts), fallback to no segment
        result = await upstoxRequest({
          hostname: 'api.upstox.com',
          path: '/v2/user/fund-margin?segment=FO',
          method: 'GET',
          headers: authHeaders
        });
        if (result.status !== 200) {
          result = await upstoxRequest({
            hostname: 'api.upstox.com',
            path: '/v2/user/fund-margin',
            method: 'GET',
            headers: authHeaders
          });
        }

      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unknown action' }));
        return;
      }

      res.writeHead(result.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.body));

    } catch(err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
});

server.listen(PORT, () => console.log(`QE Proxy running on port ${PORT}`));
