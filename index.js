// ═══════════════════════════════════════════════════════════════
// QUANTEDGE PROXY SERVER
// Runs on DigitalOcean droplet permanently via PM2
// Port 3000 — served through nginx on port 80
//
// PURPOSE: This server exists for ONE reason only.
// Upstox requires API calls to come from a whitelisted IP address.
// Your browser's IP changes. The droplet's IP is fixed.
// So the browser sends requests here, and this server forwards
// them to Upstox from the whitelisted droplet IP.
//
// ENDPOINTS:
//   POST /api  → forwards Upstox API calls
//   GET  /     → serves index.html (the trading app)
//   GET  /health → confirms server is running
// ═══════════════════════════════════════════════════════════════

const http = require('http');
const https = require('https');
const fs   = require('fs');
const path = require('path');
const PORT = process.env.PORT || 3000;
const UPSTOX_HOST = 'api.upstox.com';

function log(msg) {
  const ist = new Date(Date.now() + 330 * 60000);
  console.log(`[${ist.toISOString().slice(11,19)} IST] ${msg}`);
}

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
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

function upstoxHeaders(token, extra = {}) {
  return {
    'Authorization': `Bearer ${token}`,
    'Accept':        'application/json',
    'Content-Type':  'application/json',
    'Api-Version':   '2.0',
    ...extra,
  };
}

const actions = {

  // NIFTY spot price + OHLC — confirmed working
  market_quote: async (token) => upstoxRequest({
    hostname: UPSTOX_HOST,
    path:     '/v2/market-quote/quotes?instrument_key=NSE_INDEX%7CNifty%2050',
    method:   'GET',
    headers:  upstoxHeaders(token),
  }),

  // 5-minute intraday candles — confirmed working (v3 API)
  candles_5min: async (token) => upstoxRequest({
    hostname: UPSTOX_HOST,
    path:     '/v3/historical-candle/intraday/NSE_INDEX%7CNifty%2050/minutes/5',
    method:   'GET',
    headers:  upstoxHeaders(token),
  }),

  // Previous day OHLC — for gap detection in signal engine
  prev_day_ohlc: async (token) => {
    const today    = new Date();
    const toDate   = today.toISOString().slice(0, 10);
    const fromDate = new Date(today.setDate(today.getDate() - 5)).toISOString().slice(0, 10);
    return upstoxRequest({
      hostname: UPSTOX_HOST,
      path:     `/v2/historical-candle/NSE_INDEX%7CNifty%2050/day/${toDate}/${fromDate}`,
      method:   'GET',
      headers:  upstoxHeaders(token),
    });
  },

  // Option chain to find instrument_key for a strike
  option_chain: async (token, payload) => {
    const qs = payload.expiry_date
      ? `instrument_key=NSE_INDEX%7CNifty%2050&expiry_date=${payload.expiry_date}`
      : `instrument_key=NSE_INDEX%7CNifty%2050`;
    return upstoxRequest({
      hostname: UPSTOX_HOST,
      path:     `/v2/option/contract?${qs}`,
      method:   'GET',
      headers:  upstoxHeaders(token),
    });
  },

  // Live price for a specific option — fallback when chain has no last_price
  market_ltp: async (token, payload) => {
    const keys = Array.isArray(payload.instrument_key)
      ? payload.instrument_key.join(',')
      : payload.instrument_key;
    return upstoxRequest({
      hostname: UPSTOX_HOST,
      path:     `/v2/market-quote/ltp?instrument_key=${encodeURIComponent(keys)}`,
      method:   'GET',
      headers:  upstoxHeaders(token),
    });
  },

  // Place order — buy or sell
  place_order: async (token, payload) => {
    const body = JSON.stringify(payload);
    return upstoxRequest({
      hostname: UPSTOX_HOST,
      path:     '/v2/order/place',
      method:   'POST',
      headers:  upstoxHeaders(token, { 'Content-Length': Buffer.byteLength(body) }),
    }, body);
  },

  // Get fill price after order — called 3.5s after placing
  order_status: async (token, payload) => upstoxRequest({
    hostname: UPSTOX_HOST,
    path:     `/v2/order/details?order_id=${payload.order_id}`,
    method:   'GET',
    headers:  upstoxHeaders(token),
  }),

  // Cancel an open order
  cancel_order: async (token, payload) => upstoxRequest({
    hostname: UPSTOX_HOST,
    path:     `/v2/order/cancel?order_id=${payload.order_id}`,
    method:   'DELETE',
    headers:  upstoxHeaders(token),
  }),

  // Current positions — real LTP for SL/trail checks every 15s
  positions: async (token) => upstoxRequest({
    hostname: UPSTOX_HOST,
    path:     '/v2/portfolio/short-term-positions',
    method:   'GET',
    headers:  upstoxHeaders(token),
  }),

  // Account balance — shown on connect
  fund_margin: async (token) => upstoxRequest({
    hostname: UPSTOX_HOST,
    path:     '/v2/user/get-funds-and-margin?segment=SEC',
    method:   'GET',
    headers:  upstoxHeaders(token),
  }),

};

// ═══════════════════════════════════════════════════════════════
// HTTP SERVER
// ═══════════════════════════════════════════════════════════════

http.createServer(async (req, res) => {

  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // Serve index.html
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch(e) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'index.html not found' }));
    }
    return;
  }

  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: Math.round(process.uptime()) + 's' }));
    return;
  }

  // API proxy
  if (req.method === 'POST' && req.url === '/api') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { action, token, payload = {} } = JSON.parse(body);

        if (!action) { res.writeHead(400); res.end(JSON.stringify({ error: 'Missing action' })); return; }
        if (!token)  { res.writeHead(400); res.end(JSON.stringify({ error: 'Missing token' }));  return; }

        const handler = actions[action];
        if (!handler) { res.writeHead(400); res.end(JSON.stringify({ error: `Unknown action: ${action}` })); return; }

        log(`${action} →`);
        const result = await handler(token, payload);
        log(`${action} ← ${result.status}`);

        res.writeHead(result.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result.body));

      } catch(err) {
        log(`ERROR: ${err.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' }));

}).listen(PORT, () => {
  log(`QuantEdge proxy on port ${PORT}`);
  log(`Actions: ${Object.keys(actions).join(', ')}`);
});
