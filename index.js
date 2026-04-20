// QuantEdge AI v7.0 — Server Trading Engine
// Runs on DigitalOcean, manages all trading logic independently
// Browser is display-only. Refresh anytime. Two devices? No problem.

'use strict';
const http  = require('http');
const https = require('https');
const url   = require('url');
const fs    = require('fs');

const PORT = 3000;
const VERSION = 'v7.0';

// ─────────────────────────────────────────────
// GLOBAL STATE — persists across browser refreshes
// ─────────────────────────────────────────────
const state = {
  // Connection
  token:          null,
  broker:         'Upstox',
  connected:      false,
  // Trading
  tradingEnabled: false,
  sysStatus:      'IDLE',   // IDLE | ACTIVE | HALTED
  capital:        0,
  // Positions
  openPositions:  [],       // live trades
  trades:         [],       // completed trades
  dailyPnl:       0,
  todayTrades:    0,
  // Market data
  quotes:         { nifty:null, bnf:null, finnifty:null, nOHLC:null, bOHLC:null, fOHLC:null },
  candles:        { nifty:[], bnf:[], finnifty:[] },
  priceHistory:   { nifty:[], bnf:[], finnifty:[] },
  // Signals queue
  opps:           [],
  recentSignals:  [],
  // Config (set by browser)
  config: {
    capital:          0,
    confidenceMin:    75,
    maxDailyLoss:     1500,
    staleExitMins:    90,
    trailingStop:     true,
    autoTrade:        true,
    scalpMode:        true,
    enabledInstruments: { NIFTY:true, BANKNIFTY:false, FINNIFTY:false },
    broker:           'Upstox',
  },
  // Safety
  lossStreak:     0,
  cbActive:       false,
  cbTime:         0,
  lastResetDay:   null,
  inFlight:       0,
  blockedInst:    new Set(),
  // Logs
  logs:           [],
  alerts:         [],
  // SSE clients
  clients:        [],
};

// ─────────────────────────────────────────────
// LOGGING
// ─────────────────────────────────────────────
function log(msg, level='INFO', meta={}) {
  const entry = {
    ts:    new Date().toLocaleTimeString('en-IN',{hour12:false}),
    msg,
    level,
    meta,
  };
  state.logs.unshift(entry);
  if (state.logs.length > 2000) state.logs.length = 2000;
  console.log(`[${entry.ts}] [${level.padEnd(6)}] ${msg}`);
  push({ type:'LOG', entry });
}

// ─────────────────────────────────────────────
// SSE PUSH — send state updates to all browsers
// ─────────────────────────────────────────────
function push(data) {
  const msg = 'data: ' + JSON.stringify(data) + '\n\n';
  state.clients = state.clients.filter(res => {
    try { res.write(msg); return true; }
    catch(_) { return false; }
  });
}

function pushFullState() {
  push({
    type:     'FULL_STATE',
    version:  VERSION,
    connected:     state.connected,
    tradingEnabled:state.tradingEnabled,
    sysStatus:     state.sysStatus,
    capital:       state.capital,
    openPositions: state.openPositions,
    trades:        state.trades.slice(0,50),
    dailyPnl:      state.dailyPnl,
    todayTrades:   state.todayTrades,
    quotes:        state.quotes,
    candles:       { nifty:state.candles.nifty.slice(-80), bnf:state.candles.bnf.slice(-80), finnifty:state.candles.finnifty.slice(-80) },
    logs:          state.logs.slice(0,200),
    config:        state.config,
    cbActive:      state.cbActive,
    opps:          state.opps.slice(0,20),
  });
}

// ─────────────────────────────────────────────
// UPSTOX API CALL (direct from server)
// ─────────────────────────────────────────────
function upstoxReq(options, postData) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api.upstox.com',
      port: 443,
      method: options.method || 'GET',
      path: options.path,
      headers: {
        'Authorization': 'Bearer ' + state.token,
        'Accept':        'application/json',
        'Content-Type':  'application/json',
        ...(options.headers || {}),
      },
    };
    const req = https.request(opts, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch(_) { resolve({ status: res.statusCode, data: body }); }
      });
    });
    req.on('error', reject);
    if (postData) req.write(JSON.stringify(postData));
    req.end();
  });
}

// ─────────────────────────────────────────────
// FETCH QUOTES (market prices + OHLC)
// ─────────────────────────────────────────────
async function fetchQuotes() {
  if (!state.token) return false;
  try {
    const keys = encodeURIComponent('NSE_INDEX|Nifty 50,NSE_INDEX|Nifty Bank,NSE_INDEX|Nifty Fin Service');
    const r = await upstoxReq({ path: '/v2/market-quote/quotes?instrument_key=' + keys });
    if (r.status !== 200 || !r.data?.data) return false;
    const d   = r.data.data;
    const n   = d['NSE_INDEX:Nifty 50'];
    const b   = d['NSE_INDEX:Nifty Bank'];
    const f   = d['NSE_INDEX:Nifty Fin Service'];
    if (!n) return false;
    state.quotes = {
      nifty:    n.last_price,
      bnf:      b?.last_price || null,
      finnifty: f?.last_price || null,
      nOHLC:    n.ohlc ? { open:n.ohlc.open, high:n.ohlc.high, low:n.ohlc.low, close:n.ohlc.close } : null,
      bOHLC:    b?.ohlc ? { open:b.ohlc.open, high:b.ohlc.high, low:b.ohlc.low, close:b.ohlc.close } : null,
      fOHLC:    f?.ohlc ? { open:f.ohlc.open, high:f.ohlc.high, low:f.ohlc.low, close:f.ohlc.close } : null,
    };
    const now = new Date();
    const mk = q => ({ o:q.ohlc?.open||q.last_price, h:q.ohlc?.high||q.last_price, l:q.ohlc?.low||q.last_price, c:q.last_price, t:now });
    state.candles.nifty    = [...state.candles.nifty.slice(-79),    mk(n)];
    state.candles.bnf      = [...state.candles.bnf.slice(-79),      b ? mk(b) : (state.candles.bnf.slice(-1)[0] || mk(n))];
    state.candles.finnifty = [...state.candles.finnifty.slice(-79), f ? mk(f) : (state.candles.finnifty.slice(-1)[0] || mk(n))];
    state.priceHistory.nifty    = [...state.priceHistory.nifty.slice(-119),    n.last_price];
    state.priceHistory.bnf      = [...state.priceHistory.bnf.slice(-119),      b?.last_price||0];
    state.priceHistory.finnifty = [...state.priceHistory.finnifty.slice(-119), f?.last_price||0];
    return true;
  } catch(e) {
    log('Quote fetch error: ' + e.message, 'WARN');
    return false;
  }
}

// ─────────────────────────────────────────────
// FETCH BALANCE
// ─────────────────────────────────────────────
async function fetchBalance() {
  if (!state.token) return;
  try {
    const r = await upstoxReq({ path: '/v2/user/get-funds-and-margin?segment=SEC' });
    if (r.status === 200 && r.data?.data) {
      const avail = r.data.data.equity?.available_margin || r.data.data.commodity?.available_margin || 0;
      state.capital = Math.round(avail);
      state.config.capital = state.capital;
      log('💰 Account balance: ₹' + state.capital.toLocaleString('en-IN') + ' available', 'INFO');
      push({ type:'BALANCE', capital: state.capital });
    }
  } catch(e) {}
}

// ─────────────────────────────────────────────
// FETCH OPTION CHAIN
// ─────────────────────────────────────────────
async function fetchOptionChain(instrumentKey, expiryDate) {
  const qs = expiryDate
    ? '?instrument_key=' + encodeURIComponent(instrumentKey) + '&expiry_date=' + expiryDate
    : '?instrument_key=' + encodeURIComponent(instrumentKey);
  const r = await upstoxReq({ path: '/v2/option/contract' + qs });
  return r.data;
}

// ─────────────────────────────────────────────
// SIGNAL ENGINE — copied exactly from browser
// ─────────────────────────────────────────────

// Instrument configs (from browser code)
const nn = {
  NIFTY:     { name:'NIFTY 50',    lotSize:65, type:'INDEX', expiryDay:4, minCapital:8000,  color:'#00d4ff' },
  BANKNIFTY: { name:'BANK NIFTY',  lotSize:30, type:'INDEX', expiryDay:3, minCapital:12000, color:'#a78bfa' },
  FINNIFTY:  { name:'FIN NIFTY',   lotSize:60, type:'INDEX', expiryDay:2, minCapital:8000,  color:'#00f5a0' },
};

// Market session helper (exact copy from $u)
function getSession() {
  const t = new Date();
  const day = t.getDay();
  if (day===0||day===6) return { open:false, label:'Weekend', session:'closed', aggressiveness:0 };
  const m = t.getHours()*60 + t.getMinutes();
  if (m<540)  return { open:false, label:'Pre-Market',       session:'pre',   aggressiveness:0 };
  if (m<555)  return { open:false, label:'Pre-Open Session', session:'pre',   aggressiveness:0 };
  if (m<570)  return { open:true,  label:'Opening Rush',     session:'open',  aggressiveness:1.0, color:'orange' };
  if (m<690)  return { open:true,  label:'Morning Active',   session:'open',  aggressiveness:0.9, color:'green'  };
  if (m<810)  return { open:true,  label:'Mid-Day Slow',     session:'mid',   aggressiveness:0.5, color:'yellow' };
  if (m<870)  return { open:true,  label:'Afternoon',        session:'mid',   aggressiveness:0.7, color:'green'  };
  if (m<=930) return { open:true,  label:'Power Hour',       session:'close', aggressiveness:1.0, color:'green'  };
  return { open:false, label:'Market Closed', session:'closed', aggressiveness:0 };
}

function isMarketOpen() { return getSession().open; }

// Capital/position sizing (exact copy from Zt)
function calcRisk(capital) {
  const riskPct    = capital < 5000 ? 0.5 : capital < 20000 ? 1 : 1.5;
  const maxPos     = capital >= 15000 ? 2 : 1;
  const maxTrades  = capital < 5000 ? 3 : capital < 20000 ? 6 : 10;
  const riskAmount = Math.round(capital * riskPct / 100);
  return { riskPct, maxPositions:maxPos, maxTrades, riskAmount };
}

// Expiry day helper (ks)
function daysToExpiry(expiryDay) {
  const now = new Date();
  const diff = ((expiryDay - now.getDay()) + 7) % 7;
  return diff === 0 ? 7 : diff;
}

// EMA helper (Zg)
function calcEma(arr, period) {
  if (!arr||arr.length<period) return null;
  const k = 2/(period+1);
  let ema = arr.slice(0,period).reduce((a,b)=>a+b,0)/period;
  for (let i=period;i<arr.length;i++) ema = arr[i]*k + ema*(1-k);
  return ema;
}

// Supertrend helper (_1)
function calcSupertrend(candles) {
  if (!candles||candles.length<16) return null;
  const recent = candles.slice(-16);
  let bulls=0, bears=0;
  for (let i=1;i<recent.length;i++) {
    if (recent[i].c > recent[i-1].c) bulls++;
    else bears++;
  }
  return bulls > bears ? { trend:'UP' } : { trend:'DOWN' };
}

// Candlestick pattern (z1)
function detectPattern(candles) {
  if (!candles||candles.length<3) return null;
  const [c1,c2,c3] = candles.slice(-3);
  const body1 = Math.abs(c1.c-c1.o), body2 = Math.abs(c2.c-c2.o), body3 = Math.abs(c3.c-c3.o);
  if (c1.c<c1.o && c2.c>c2.o && c3.c>c3.o && c3.c>c1.o) return { pattern:'Bullish Engulfing', bias:'bullish', strength:80 };
  if (c1.c>c1.o && c2.c<c2.o && c3.c<c3.o && c3.c<c1.o) return { pattern:'Bearish Engulfing', bias:'bearish', strength:80 };
  if (body2 < body1*0.1 && body2 < body3*0.1) return { pattern:'Doji', bias: c3.c>c3.o?'bullish':'bearish', strength:70 };
  return null;
}

// Black-Scholes approximation (Is) — simplified
function bsPrice(spot, strike, dte, iv, isCall) {
  if (!spot||!strike||!dte) return null;
  const intrinsic = isCall ? Math.max(0, spot-strike) : Math.max(0, strike-spot);
  const timeVal   = spot * iv * Math.sqrt(Math.max(0.001, dte/365)) * 0.4;
  return Math.max(0.5, intrinsic + timeVal);
}

// ─────────────────────────────────────────────
// MAIN SIGNAL ENGINE (Fg equivalent)
// ─────────────────────────────────────────────
function runSignalEngine(instrument, spot, ohlc, candles, cfg, capital) {
  const sess    = getSession();
  const mins    = new Date().getHours()*60 + new Date().getMinutes();
  if (!sess.open || mins >= 915) return null;  // Hard lock 15:15
  if (mins < 560) return null;  // No trades before 9:20 AM — avoid fake open moves

  let score = 30;
  const reasons = [];
  let direction = null;
  let pattern   = null;

  score += Math.round(sess.aggressiveness * 15);
  if (sess.session==='open'||sess.session==='close') reasons.push('High-activity ' + sess.label);

  // Opening rush filter — skip if huge gap
  if (mins>=555 && mins<570 && ohlc?.open && Math.abs(spot-ohlc.open)/ohlc.open*100 > 0.5) return null;

  // Day range position
  if (ohlc?.high && ohlc?.low && ohlc?.open) {
    const range = ohlc.high - ohlc.low;
    if (range > 0) {
      const pos = (spot - ohlc.low) / range;
      if (pos > 0.72)      { reasons.push('Top of day range — bullish'); score += 13; direction = 'CE'; }
      else if (pos < 0.28) { reasons.push('Bottom of day range — bearish'); score += 13; direction = 'PE'; }
    }
    if (spot > ohlc.open)  { reasons.push('Above open — bullish day bias'); score += 8; if (!direction) direction = 'CE'; }
    else                   { reasons.push('Below open — bearish day bias'); score += 8; if (!direction) direction = 'PE'; }
    if (Math.abs(spot-ohlc.high)/spot < 0.0015) { reasons.push('Near day high — breakout'); score += 12; direction = 'CE'; pattern = 'Breakout'; }
    if (Math.abs(spot-ohlc.low)/spot < 0.0015)  { reasons.push('Near day low — bounce');    score += 12; direction = 'PE'; pattern = 'Bounce'; }
  }

  // Supertrend
  if (candles.length > 16) {
    const st = calcSupertrend(candles);
    if (st) {
      reasons.push('Supertrend ' + (st.trend==='UP'?'BULLISH':'BEARISH'));
      score += 10;
      if (!direction) direction = st.trend==='UP' ? 'CE' : 'PE';
      if (!pattern)   pattern   = 'Trend Follow';
    }
  }

  // EMA 9/21
  if (candles.length > 22) {
    const closes = candles.map(c => c.c);
    const ema9  = calcEma(closes, 9);
    const ema21 = calcEma(closes, 21);
    if (ema9 && ema21) {
      if (ema9 > ema21) { reasons.push('9 EMA > 21 EMA — bullish cross'); score += 9; if (!direction) direction = 'CE'; }
      else              { reasons.push('9 EMA < 21 EMA — bearish cross'); score += 9; if (!direction) direction = 'PE'; }
    }
  }

  // RSI
  if (candles.length > 14) {
    const closes = candles.map(c => c.c);
    let gains=0, losses=0;
    for (let i=closes.length-14; i<closes.length; i++) {
      const d = closes[i] - closes[i-1];
      if (d>0) gains+=d; else losses+=Math.abs(d);
    }
    const rs  = losses===0 ? 100 : gains/14 / (losses/14);
    const rsi = 100 - 100/(1+rs);
    if (rsi < 35)      { reasons.push('RSI ' + rsi.toFixed(0) + ' — oversold'); score += 8; if (!direction) direction = 'PE'; }
    else if (rsi > 65) { reasons.push('RSI ' + rsi.toFixed(0) + ' — overbought'); score += 8; if (!direction) direction = 'CE'; }
    if (rsi>50 && direction==='CE') { reasons.push('RSI bullish momentum'); score += 4; }
    if (rsi<50 && direction==='PE') { reasons.push('RSI bearish momentum'); score += 4; }
  }

  // Bollinger Bands
  if (candles.length >= 20) {
    const cls  = candles.slice(-20).map(c=>c.c);
    const mean = cls.reduce((a,b)=>a+b,0)/20;
    const std  = Math.sqrt(cls.reduce((a,b)=>a+(b-mean)**2,0)/20);
    const upper= mean + 2*std, lower = mean - 2*std;
    const bw   = (upper-lower)/mean;
    if (spot < lower) { reasons.push('Below BB lower — oversold'); score += 8; if (!direction) direction = 'PE'; if (!pattern) pattern = 'Bounce'; }
    if (spot > upper) { reasons.push('Above BB upper — breakout'); score += 8; if (!direction) direction = 'CE'; if (!pattern) pattern = 'Breakout'; }
    if (bw < 0.02)    { reasons.push('Bollinger squeeze — breakout imminent'); score += 5; }
  }

  // Candlestick patterns
  if (candles.length >= 3) {
    const pat = detectPattern(candles);
    if (pat) {
      reasons.push(pat.pattern + ' pattern — ' + pat.bias);
      score += pat.strength > 75 ? 12 : 7;
      if (pat.bias==='bullish' && !direction) direction = 'CE';
      if (pat.bias==='bearish' && !direction) direction = 'PE';
      if (!pattern) pattern = pat.bias==='bullish' ? 'Momentum' : 'Reversal';
    }
  }

  // Score cap
  score = Math.min(97, score);

  // Minimum thresholds
  const minScores = { NIFTY:80, BANKNIFTY:85, FINNIFTY:78 };
  const minConf   = Math.max(cfg.confidenceMin||75, minScores[instrument]||0);
  const openMin   = (mins>=555&&mins<570) ? Math.max(minConf,78) : minConf;
  const threshold = openMin;

  if (score < threshold || !direction) return null;

  // Final pattern name
  if (!pattern) pattern = direction==='CE' ? 'Momentum CE' : 'Momentum PE';

  const instCfg  = nn[instrument];
  const strike   = direction==='CE'
    ? Math.ceil(spot/50)*50
    : Math.floor(spot/50)*50;
  const dte      = daysToExpiry(instCfg.expiryDay);
  const ivMap    = { NIFTY:0.18, BANKNIFTY:0.22, FINNIFTY:0.20 };
  const estPrem  = bsPrice(spot, strike, dte, ivMap[instrument]||0.18, direction==='CE');
  const cost     = Math.round((estPrem||100) * instCfg.lotSize);
  const signalType = score >= 90 ? 'SCALP' : 'SWING';

  return {
    id:         Date.now() + '_' + instrument,
    key:        instrument + '-' + direction,
    instrument, direction, strike, score, pattern,
    premium:    estPrem,
    cost,
    type:       direction==='CE' ? instrument+' '+strike+' CE' : instrument+' '+strike+' PE',
    signalType,
    reasons,
    ts:         Date.now(),
    status:     'PENDING',
  };
}

// ─────────────────────────────────────────────
// BUY EXECUTION
// ─────────────────────────────────────────────
async function executeBuy(signal) {
  const cfg  = state.config;
  const creds = { access_token: state.token };

  // Safety checks — hard gate: market hours + server active
  if (!isMarketOpen()) { log('Market closed — buy blocked (' + signal.type + ')', 'WARN'); return; }
  if (!state.tradingEnabled || state.sysStatus !== 'ACTIVE') return;
  if (state.cbActive) { log('CB active — buy blocked', 'WARN'); return; }
  if (state.openPositions.length >= calcRisk(state.capital).maxPositions) { log('Max positions reached', 'WARN'); return; }
  if (state.todayTrades >= calcRisk(state.capital).maxTrades) { log('Max trades reached', 'WARN'); return; }

  // Instrument enabled?
  if (!cfg.enabledInstruments?.[signal.instrument]) return;

  // Blocked from refresh-guard?
  if (state.blockedInst.has(signal.instrument)) {
    log('🔒 BLOCKED: ' + signal.instrument + ' already open on Upstox', 'WARN');
    return;
  }

  // Dedup — same instrument already open in our state
  if (state.openPositions.some(p => p.instrument===signal.instrument && p.direction===signal.direction)) {
    log('BLOCKED DUPLICATE: ' + signal.instrument + ' ' + signal.direction + ' already open', 'WARN');
    return;
  }

  // Signal TTL
  if (Date.now() - signal.ts > 90000) {
    log('SIGNAL EXPIRED: ' + signal.type + ' >90s old — discarded', 'WARN');
    return;
  }

  // Cooldown check
  const rcKey    = 'rc_' + signal.key;
  const rcWinKey = 'rc_win_' + signal.key;
  const now = Date.now();
  const lastClose = state['cooldown_' + signal.key] || 0;
  const lastWin   = state['cooldown_win_' + signal.key] || 0;
  if (lastClose > 0) {
    const sinceClose = now - lastClose;
    const sinceWin   = now - lastWin;
    if (lastWin > 0 && sinceWin < 300000 && signal.score < 90) {
      log('COOLDOWN (WIN): ' + signal.key + ' ' + Math.ceil((300000-sinceWin)/60000) + 'min remaining', 'WARN');
      return;
    }
    if (lastWin === 0 && sinceClose < 1200000 && signal.score < 93) {
      log('COOLDOWN (LOSS): ' + signal.key + ' ' + Math.ceil((1200000-sinceClose)/60000) + 'min remaining', 'WARN');
      return;
    }
  }

  // Margin check
  const availBal  = state.capital * 0.85;
  const existCost = state.openPositions.reduce((a,p) => a+p.cost, 0);
  if (existCost + signal.cost > availBal) {
    log('BLOCKED: insufficient margin (' + signal.instrument + ' cost ₹' + signal.cost + ')', 'WARN');
    return;
  }

  log('⏳ Real order: ' + signal.type + ' x' + nn[signal.instrument].lotSize + '...', 'INFO');
  state.inFlight++;

  try {
    // Fetch option chain to get real expiry and instrument key
    const idxMap = { NIFTY:'NSE_INDEX|Nifty 50', BANKNIFTY:'NSE_INDEX|Nifty Bank', FINNIFTY:'NSE_INDEX|Nifty Fin Service' };
    const instrKey = idxMap[signal.instrument];

    // Get expiry within 10 days
    const chainData = await fetchOptionChain(instrKey);
    const contracts = chainData?.data || [];
    const expiries  = [...new Set(contracts.map(c=>c.expiry))].sort();
    const today     = new Date().toISOString().slice(0,10);
    const tenDays   = new Date(Date.now()+10*86400000).toISOString().slice(0,10);
    const weekly    = expiries.filter(d => d > today && d <= tenDays);

    if (weekly.length === 0) {
      log('BLOCKED: ' + signal.instrument + ' no weekly expiry — monthly too expensive. Skipping.', 'WARN');
      state.inFlight--;
      return;
    }

    const usedExpiry = weekly[0];

    // Same-day expiry block
    if (usedExpiry === today) {
      log('🚫 BLOCKED: ' + signal.instrument + ' expiry is TODAY — options too cheap/risky on expiry day', 'WARN');
      state.inFlight--;
      return;
    }

    // Find contracts for this expiry and strike
    const strikeContracts = contracts.filter(c =>
      c.expiry === usedExpiry &&
      Number(c.strike_price) === Number(signal.strike) &&
      c.instrument_type === signal.direction
    );

    if (!strikeContracts.length) {
      log('No contracts found for ' + signal.type + ' expiry ' + usedExpiry, 'WARN');
      state.inFlight--;
      return;
    }

    const realInstrumentKey = strikeContracts[0].instrument_key;
    const lotSize = nn[signal.instrument].lotSize;

    log('✅ Using nearest expiry: ' + usedExpiry + ' (' + strikeContracts.length + ' contracts)', 'INFO');

    // Place MARKET BUY
    const orderPayload = {
      quantity:            lotSize,
      product:             'I',
      validity:            'DAY',
      price:               0,
      tag:                 'quantedge',
      instrument_token:    realInstrumentKey,
      order_type:          'MARKET',
      transaction_type:    'BUY',
      disclosed_quantity:  0,
      trigger_price:       0,
      is_amo:              false,
    };

    const orderRes = await upstoxReq({ path:'/v2/order/place', method:'POST' }, orderPayload);

    if (orderRes.status !== 200 || orderRes.data?.status !== 'success') {
      const errMsg = orderRes.data?.errors?.[0]?.message || orderRes.data?.message || 'Order failed';
      log('❌ BUY FAILED: ' + errMsg, 'WARN');
      state.inFlight--;
      return;
    }

    const orderId = orderRes.data?.data?.order_id;
    log('✅ REAL BUY PLACED: ' + signal.instrument + ' ' + signal.strike + ' ' + signal.direction + ' x' + lotSize + ' | Order: ' + orderId, 'INFO');

    // Wait 3.5s then fetch real fill price
    await new Promise(r => setTimeout(r, 3500));

    let realAvgPrice = signal.premium || 100;
    try {
      const statusRes = await upstoxReq({ path: '/v2/order/details?order_id=' + orderId });
      const avg = statusRes.data?.data?.average_price || statusRes.data?.data?.avg_price;
      if (avg && avg > 0) realAvgPrice = avg;
    } catch(_) {}

    log('REAL FILL CONFIRMED: ' + signal.instrument + ' ' + signal.strike + ' avg ₹' + realAvgPrice, 'INFO');

    // Set SL and Target from real fill
    const sl     = Math.round(realAvgPrice * 0.75);
    const target = Math.round(realAvgPrice * 1.30);
    const cost   = Math.round(realAvgPrice * lotSize);

    const position = {
      id:                Date.now() + '_pos',
      key:               signal.key,
      instrument:        signal.instrument,
      direction:         signal.direction,
      strike:            signal.strike,
      type:              signal.type,
      qty:               lotSize,
      entryPrice:        realAvgPrice,
      currentPrem:       realAvgPrice,
      sl,
      target,
      cost,
      entryTime:         new Date().toISOString(),
      realOrderId:       orderId,
      realInstrumentKey,
      realExpiryDate:    usedExpiry,
      targetOrderId:     null,
      _trailLock:        null,
      unrealizedPnl:     0,
      status:            'OPEN',
    };

    state.openPositions.push(position);
    state.todayTrades++;
    state.blockedInst.add(signal.instrument);

    log('TRADE OPEN: ' + signal.type + ' | Entry ₹' + realAvgPrice + ' | SL ₹' + sl + ' | Target ₹' + target + ' | Qty ' + lotSize + ' | Cost ₹' + cost + ' | ' + signal.pattern + ' | ' + signal.signalType + ' | Confidence ' + signal.score + '%', 'TRADE');

    // Place target LIMIT sell order
    try {
      const targetPayload = {
        quantity:            lotSize,
        product:             'I',
        validity:            'DAY',
        price:               target,
        tag:                 'qe_target',
        instrument_token:    realInstrumentKey,
        order_type:          'LIMIT',
        transaction_type:    'SELL',
        disclosed_quantity:  0,
        trigger_price:       0,
        is_amo:              false,
      };
      const tRes = await upstoxReq({ path:'/v2/order/place', method:'POST' }, targetPayload);
      if (tRes.data?.status === 'success') {
        const tOId = tRes.data?.data?.order_id;
        position.targetOrderId = tOId;
        log('TARGET LIMIT ORDER placed @ ₹' + target + ' Order: ' + tOId, 'INFO');
      }
    } catch(_) {}

    pushFullState();

  } catch(e) {
    log('❌ BUY ERROR: ' + e.message + ' — CLOSE MANUALLY', 'WARN');
  }
  state.inFlight--;
}

// ─────────────────────────────────────────────
// SELL EXECUTION
// ─────────────────────────────────────────────
async function executeSell(pos, reason) {
  if (!pos.realInstrumentKey) {
    log('Cannot sell ' + pos.type + ' — no realInstrumentKey', 'WARN');
    return;
  }

  // Cancel target limit order first
  if (pos.targetOrderId) {
    try {
      await upstoxReq({ path: '/v2/order/cancel?order_id=' + pos.targetOrderId, method: 'DELETE' });
      log('Cancelled target limit order ' + pos.targetOrderId, 'INFO');
    } catch(_) {}
    pos.targetOrderId = null;
  }

  // Place MARKET SELL
  try {
    const payload = {
      quantity:           pos.qty,
      product:            'I',
      validity:           'DAY',
      price:              0,
      tag:                'quantedge',
      instrument_token:   pos.realInstrumentKey,
      order_type:         'MARKET',
      transaction_type:   'SELL',
      disclosed_quantity: 0,
      trigger_price:      0,
      is_amo:             false,
    };
    const r = await upstoxReq({ path:'/v2/order/place', method:'POST' }, payload);
    if (r.status !== 200 || r.data?.status !== 'success') {
      const err = r.data?.errors?.[0]?.message || r.data?.message || 'SELL failed';
      log('❌ SELL FAILED: ' + err + ' — CLOSE MANUALLY', 'WARN');
      return;
    }
    const sellOrderId = r.data?.data?.order_id;
    log('✅ REAL SELL PLACED: ' + pos.instrument + ' ' + pos.strike + ' | Order: ' + sellOrderId, 'INFO');

    // Remove from open positions immediately
    state.openPositions = state.openPositions.filter(p => p.id !== pos.id);
    state.blockedInst.delete(pos.instrument);

    // Compute pnl with current price
    const exitPremEst = pos.currentPrem || pos.entryPrice;
    const rawPnl  = Math.round((exitPremEst - pos.entryPrice) * pos.qty);
    const fees    = Math.round(48 + (exitPremEst*pos.qty*0.0005) + ((pos.entryPrice+exitPremEst)*pos.qty*0.00053));
    const netPnl  = rawPnl - fees;
    const holdMin = Math.round((Date.now() - new Date(pos.entryTime).getTime()) / 60000);

    const trade = {
      ...pos,
      exitPrice:   exitPremEst,
      exitTime:    new Date().toISOString(),
      pnl:         netPnl,
      fees,
      closeReason: reason,
      holdMins:    holdMin,
      status:      netPnl >= 0 ? 'WIN' : 'LOSS',
    };
    state.trades.unshift(trade);
    state.dailyPnl += netPnl;

    log(reason + ': ' + pos.type + ' | ₹' + pos.entryPrice + '→₹' + exitPremEst + ' | ' + (netPnl>=0?'+₹':'-₹') + Math.abs(netPnl) + ' | Qty ' + pos.qty + ' | Held ' + holdMin + 'm', netPnl>=0?'WIN':'LOSS');

    // Cooldown tracking
    const now = Date.now();
    state['cooldown_' + pos.key] = now;
    if (netPnl > 100) state['cooldown_win_' + pos.key] = now;
    else delete state['cooldown_win_' + pos.key];

    // CB check — only on confirmed real loss > ₹100
    if (netPnl < -100 && pos.realOrderId && pos.realOrderId.length > 5 &&
        reason !== 'TARGET HIT' && reason !== 'STALE AUTO-CLOSE') {
      state.lossStreak++;
      if (state.lossStreak >= 2) {
        state.cbActive   = true;
        state.cbTime     = Date.now();
        state.lossStreak = 0;
        state.sysStatus  = 'HALTED';
        log('🔴 Circuit breaker: 2 consecutive losses — trading halted for 15 min', 'SYSTEM');
        setTimeout(() => {
          state.cbActive  = false;
          state.sysStatus = 'ACTIVE';
          log('🟢 Circuit breaker lifted — trading resumed', 'SYSTEM');
          push({ type:'CB_LIFTED' });
        }, 900000);
      }
    } else if (netPnl > 100) {
      state.lossStreak = 0;
    }

    // Fetch real exit price 3.5s later and update
    if (sellOrderId) {
      setTimeout(async () => {
        try {
          const sr = await upstoxReq({ path: '/v2/order/details?order_id=' + sellOrderId });
          const exitAvg = sr.data?.data?.average_price || sr.data?.data?.avg_price;
          if (exitAvg && exitAvg > 0) {
            // Update the trade record with real price
            const t = state.trades.find(tr => tr.id === pos.id);
            if (t) {
              const rp2  = Math.round((exitAvg - t.entryPrice) * t.qty);
              const f2   = Math.round(48 + (exitAvg*t.qty*0.0005) + ((t.entryPrice+exitAvg)*t.qty*0.00053));
              const np2  = rp2 - f2;
              const diff = np2 - t.pnl;
              t.exitPrice = exitAvg;
              t.pnl       = np2;
              t.fees      = f2;
              t.status    = np2 >= 0 ? 'WIN' : 'LOSS';
              state.dailyPnl += diff;
              log('REAL EXIT CONFIRMED: ' + pos.instrument + ' ' + pos.strike + ' avg ₹' + exitAvg, 'INFO');
              pushFullState();
            }
          }
        } catch(_) {}
      }, 3500);
    }

    pushFullState();

  } catch(e) {
    log('❌ SELL ERROR: ' + e.message + ' — CLOSE MANUALLY', 'WARN');
  }
}

// ─────────────────────────────────────────────
// POSITION MONITOR — runs every 10s
// Trail, SL, Target checks
// ─────────────────────────────────────────────
async function monitorPositions() {
  if (!state.openPositions.length || !state.token) return;
  const cfg = state.config;

  for (const pos of [...state.openPositions]) {
    // Fetch real LTP from option chain
    try {
      const key      = 'NSE_INDEX|' + pos.instrument;
      const chainRes = await fetchOptionChain(key, pos.realExpiryDate);
      const contracts = chainRes?.data || [];
      const match     = contracts.find(c =>
        Number(c.strike_price) === Number(pos.strike) &&
        c.instrument_type === pos.direction
      );
      if (match?.last_price && match.last_price > 0) {
        pos.currentPrem    = match.last_price;
        pos.unrealizedPnl  = Math.round((pos.currentPrem - pos.entryPrice) * pos.qty);
        log('📊 ' + pos.instrument + ' ' + pos.strike + pos.direction + ' LTP ₹' + pos.currentPrem, 'INFO');
      }
    } catch(_) {}

    const prem = pos.currentPrem;
    if (!prem) continue;

    // Trail logic
    const m = (prem - pos.entryPrice) / pos.entryPrice;
    if (m >= 1.0 && pos._trailLock !== '100pct') {
      const newSl = Math.round(pos.entryPrice * 1.70);
      if (newSl > pos.sl) { pos.sl = newSl; pos._trailLock = '100pct'; log('🔥 TRAIL +100%: ' + pos.type + ' SL locked @ ₹' + newSl + ' (70% profit protected)', 'INFO'); }
    } else if (m >= 0.75 && !['100pct','75pct'].includes(pos._trailLock)) {
      const newSl = Math.round(pos.entryPrice * 1.50);
      if (newSl > pos.sl) { pos.sl = newSl; pos._trailLock = '75pct'; log('📈 TRAIL +75%: ' + pos.type + ' SL locked @ ₹' + newSl + ' (50% profit protected)', 'INFO'); }
    } else if (m >= 0.50 && !['100pct','75pct','50pct'].includes(pos._trailLock)) {
      const newSl = Math.round(pos.entryPrice * 1.30);
      if (newSl > pos.sl) { pos.sl = newSl; pos._trailLock = '50pct'; log('💰 TRAIL +50%: ' + pos.type + ' SL locked @ ₹' + newSl + ' (30% profit protected)', 'INFO'); }
    } else if (m >= 0.25 && pos.sl < pos.entryPrice * 1.1) {
      const newSl = Math.round(pos.entryPrice * 1.10);
      if (newSl > pos.sl) { pos.sl = newSl; pos._trailLock = '25pct'; log('📉 TRAIL +25%: ' + pos.type + ' SL to ₹' + newSl + ' (break-even +10%)', 'INFO'); }
    } else if (m >= 0.15 && pos.sl < pos.entryPrice && !pos._trailLock) {
      const newSl = Math.round(pos.entryPrice);
      if (newSl > pos.sl) { pos.sl = newSl; pos._trailLock = '15pct'; log('✅ TRAIL +15%: ' + pos.type + ' SL moved to entry ₹' + newSl + ' (break-even)', 'INFO'); }
    }

    // SL hit
    if (prem <= pos.sl) {
      log('SL HIT: ' + pos.type + ' @ ₹' + prem + ' (SL was ₹' + pos.sl + ')', 'WARN');
      await executeSell(pos, 'SL HIT');
      continue;
    }

    // Target hit (only when trail not active)
    if (!pos._trailLock && prem >= pos.target) {
      log('TARGET HIT: ' + pos.type + ' @ ₹' + prem, 'INFO');
      await executeSell(pos, 'TARGET HIT');
      continue;
    }

    // Check if target limit order was filled by exchange
    if (pos.targetOrderId) {
      try {
        const sr = await upstoxReq({ path: '/v2/order/details?order_id=' + pos.targetOrderId });
        const status = sr.data?.data?.status;
        if (status === 'complete' || status === 'filled') {
          log('TARGET HIT (limit filled): ' + pos.type, 'INFO');
          state.openPositions = state.openPositions.filter(p => p.id !== pos.id);
          // Update as completed trade
          const exitAvg = sr.data?.data?.average_price || pos.target;
          const rp  = Math.round((exitAvg - pos.entryPrice) * pos.qty);
          const f   = Math.round(48 + (exitAvg*pos.qty*0.0005) + ((pos.entryPrice+exitAvg)*pos.qty*0.00053));
          const np  = rp - f;
          state.trades.unshift({ ...pos, exitPrice:exitAvg, pnl:np, fees:f, closeReason:'TARGET HIT', status:np>=0?'WIN':'LOSS' });
          state.dailyPnl += np;
          state.blockedInst.delete(pos.instrument);
          state.lossStreak = 0;
          pushFullState();
        }
      } catch(_) {}
    }
  }

  push({ type:'POSITIONS', positions: state.openPositions });
}

// ─────────────────────────────────────────────
// STALE EXIT MONITOR — runs every 60s
// ─────────────────────────────────────────────
async function checkStaleExits() {
  if (!state.openPositions.length || !state.tradingEnabled) return;
  const staleMin = state.config.staleExitMins || 90;
  const now      = Date.now();

  for (const pos of [...state.openPositions]) {
    const heldMin = (now - new Date(pos.entryTime).getTime()) / 60000;
    if (heldMin < staleMin) continue;

    // Trail active? Skip stale exit
    if (pos._trailLock) {
      log('STALE SKIP: ' + pos.type + ' — trail active (' + pos._trailLock + '), SL at ₹' + pos.sl + ' protecting profit', 'INFO');
      continue;
    }

    // Fetch fresh price before exiting
    let exitPrice = pos.currentPrem || pos.entryPrice;
    try {
      const key      = 'NSE_INDEX|' + pos.instrument;
      const chainRes = await fetchOptionChain(key, pos.realExpiryDate);
      const contracts = chainRes?.data || [];
      const match     = contracts.find(c =>
        Number(c.strike_price) === Number(pos.strike) &&
        c.instrument_type === pos.direction
      );
      if (match?.last_price && match.last_price > 0) exitPrice = match.last_price;
    } catch(_) {}

    log('STALE EXIT: ' + pos.instrument + ' ' + pos.strike + ' held ' + Math.round(heldMin) + 'min — auto-closing @ ₹' + exitPrice, 'WARN');
    pos.currentPrem = exitPrice;
    await executeSell(pos, 'STALE AUTO-CLOSE');
  }
}

// ─────────────────────────────────────────────
// EOD CLOSE — fires at 15:10
// ─────────────────────────────────────────────
let eodFired = false;
function checkEod() {
  const m = new Date().getHours()*60 + new Date().getMinutes();
  if (m < 910) { eodFired = false; return; }
  if (m >= 910 && m < 912 && !eodFired && state.openPositions.length > 0 && state.tradingEnabled) {
    eodFired = true;
    log('EOD: Auto-closing at 15:10 (before broker square-off)', 'SYSTEM');
    for (const pos of [...state.openPositions]) {
      executeSell(pos, 'EOD AUTO-CLOSE');
    }
  }
}

// ─────────────────────────────────────────────
// SIGNAL SCAN — runs every 60s
// ─────────────────────────────────────────────
function runScan() {
  if (!state.tradingEnabled || state.sysStatus !== 'ACTIVE' || !isMarketOpen()) return;
  if (state.cbActive) return;

  const sess  = getSession();
  const mins  = new Date().getHours()*60 + new Date().getMinutes();
  if (mins >= 915) return;
  if (mins < 560) { return; } // No trades before 9:20 — opening fake-moves

  const results = [];
  const instruments = Object.keys(state.config.enabledInstruments || {}).filter(k =>
    state.config.enabledInstruments[k] && nn[k]
  );

  for (const inst of instruments) {
    const spot   = inst==='NIFTY' ? state.quotes.nifty : inst==='BANKNIFTY' ? state.quotes.bnf : state.quotes.finnifty;
    const ohlc   = inst==='NIFTY' ? state.quotes.nOHLC : inst==='BANKNIFTY' ? state.quotes.bOHLC : state.quotes.fOHLC;
    const cnd    = state.candles[inst==='BANKNIFTY'?'bnf':inst.toLowerCase()] || state.candles.nifty;
    if (!spot) continue;

    const sig = runSignalEngine(inst, spot, ohlc, cnd, state.config, state.capital);
    if (sig) {
      // Check if already processed this key recently
      const lastSig = state.recentSignals.find(s => s.key === sig.key);
      if (lastSig && Date.now() - lastSig.ts < 60000) continue; // dedup 60s

      log('SIGNAL: ' + sig.type + ' | ' + sig.score + '% | ' + sig.pattern + ' | ₹' + sig.cost + ' | ' + sig.signalType, 'SIGNAL');
      state.opps = [sig, ...state.opps.slice(0,19)];
      state.recentSignals = [{ key:sig.key, ts:Date.now() }, ...state.recentSignals.slice(0,49)];
      results.push(sig);

      // Auto-trade
      if (state.config.autoTrade) {
        executeBuy(sig).catch(e => log('Buy error: ' + e.message, 'WARN'));
      }
    }
  }

  push({ type:'SCAN', opps: state.opps.slice(0,10) });
}

// ─────────────────────────────────────────────
// OPEN POSITIONS FETCH ON CONNECT
// Cancel orphaned orders, build block set
// ─────────────────────────────────────────────
async function fetchOpenPositionsOnConnect() {
  try {
    const r = await upstoxReq({ path: '/v2/portfolio/short-term-positions' });
    const positions = (r.data?.data || []).filter(p => p.quantity > 0);
    state.blockedInst = new Set();
    for (const p of positions) {
      const sym  = p.trading_symbol || '';
      const inst = sym.includes('BANKNIFTY') ? 'BANKNIFTY' : sym.includes('FINNIFTY') ? 'FINNIFTY' : sym.includes('NIFTY') ? 'NIFTY' : sym.split('-')[0];
      state.blockedInst.add(inst);
      log('⚠️ Open on Upstox: ' + sym + ' qty=' + p.quantity + ' — blocking new ' + inst + ' entry', 'WARN');
    }

    // Cancel orphaned target orders
    const or = await upstoxReq({ path: '/v2/order/retrieve-all' });
    const orphans = (or.data?.data || []).filter(o => (o.status==='open'||o.status==='pending') && o.tag==='qe_target');
    if (orphans.length > 0) {
      log('🧹 Cancelling ' + orphans.length + ' orphaned target order(s) from previous session', 'WARN');
      for (const o of orphans) {
        try {
          await upstoxReq({ path: '/v2/order/cancel?order_id=' + o.order_id, method: 'DELETE' });
          log('🗑️ Orphan cancelled: ' + o.trading_symbol + ' ' + o.order_id, 'INFO');
        } catch(_) {}
      }
    }
  } catch(e) {
    log('Position fetch on connect failed: ' + e.message, 'WARN');
  }
}

// ─────────────────────────────────────────────
// DAILY RESET
// ─────────────────────────────────────────────
function checkDailyReset() {
  const today = new Date().toDateString();
  if (state.lastResetDay === today) return;
  state.lastResetDay = today;
  state.lossStreak   = 0;
  state.cbActive     = false;
  state.dailyPnl     = 0;
  state.todayTrades  = 0;
  eodFired           = false;
  // Clear all cooldowns
  Object.keys(state).filter(k => k.startsWith('cooldown_')).forEach(k => delete state[k]);
  log('✅ New trading day — CB and cooldowns auto-cleared', 'SYSTEM');
}

// ─────────────────────────────────────────────
// MAIN LOOPS
// ─────────────────────────────────────────────
let scanTimer     = null;
let monitorTimer  = null;
let staleTimer    = null;
let eodTimer      = null;
let pushTimer     = null;

function startLoops() {
  if (scanTimer) {
    log('Loops running — token updated, waiting for START_TRADING', 'SYSTEM');
    return;
  }
  log('Starting trading loops...', 'SYSTEM');

  // Quote fetch + scan every 10s
  scanTimer = setInterval(async () => {
    if (!state.token || !state.connected) return;
    const ok = await fetchQuotes();
    if (!ok) return;
    if (state.tradingEnabled) runScan();
    push({ type:'QUOTES', quotes:state.quotes });
  }, 10000);

  // Position monitor every 15s
  monitorTimer = setInterval(() => {
    if (state.tradingEnabled && state.openPositions.length > 0) {
      monitorPositions().catch(e => log('Monitor error: ' + e.message, 'WARN'));
    }
  }, 15000);

  // Stale exit check every 60s
  staleTimer = setInterval(() => {
    checkStaleExits().catch(e => log('Stale check error: ' + e.message, 'WARN'));
  }, 60000);

  // EOD + CB check every 30s
  eodTimer = setInterval(() => {
    checkEod();
    if (state.cbActive && Date.now() - state.cbTime > 900000) {
      state.cbActive  = false;
      state.sysStatus = state.tradingEnabled ? 'ACTIVE' : 'IDLE';
      log('🟢 Circuit breaker lifted — trading resumed', 'SYSTEM');
    }
  }, 30000);

  // Push full state to browsers every 5s
  pushTimer = setInterval(() => {
    if (state.clients.length > 0) pushFullState();
  }, 5000);
}

// ─────────────────────────────────────────────
// HTTP SERVER
// ─────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const path   = parsed.pathname;

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // ── SSE stream — browser connects here ──
  if (path === '/stream') {
    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    state.clients.push(res);
    // Send full state immediately on connect
    setTimeout(() => {
      try { res.write('data: ' + JSON.stringify({ type:'FULL_STATE', ...getFullState() }) + '\n\n'); } catch(_){}
    }, 100);
    req.on('close', () => {
      state.clients = state.clients.filter(c => c !== res);
    });
    return;
  }

  // ── Command endpoint ──
  if (path === '/command' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const cmd = JSON.parse(body);
        await handleCommand(cmd, res);
      } catch(e) {
        res.writeHead(400, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── Health check ──
  if (path === '/health') {
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ status:'ok', version:VERSION, connected:state.connected, trading:state.tradingEnabled, positions:state.openPositions.length }));
    return;
  }

  // ── Legacy proxy endpoint (backward compat) ──
  // Legacy proxy: accept ANY POST that isn't /stream, /command, /health
  // This matches old proxy behavior regardless of nginx path rewriting
  if (req.method === 'POST' && path !== '/command') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const { action, token, payload } = JSON.parse(body);
        // Use provided token OR server token
        const useToken = token || state.token;
        if (!useToken) { res.writeHead(401); res.end(JSON.stringify({error:'No token'})); return; }
        const result = await handleProxyAction(action, payload, useToken);
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify(result));
      } catch(e) {
        res.writeHead(500, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404); res.end('Not found');
});

// ─────────────────────────────────────────────
// COMMAND HANDLER
// ─────────────────────────────────────────────
async function handleCommand(cmd, res) {
  res.writeHead(200, {'Content-Type':'application/json'});

  switch(cmd.type) {

    case 'CONNECT': {
      const token = cmd.token;
      if (!token) { res.end(JSON.stringify({error:'No token'})); return; }
      state.token          = token;
      state.connected      = false;
      state.tradingEnabled = false;  // always reset — waits for START_TRADING
      state.sysStatus      = 'IDLE';
      // Verify token by fetching balance
      try {
        const r = await upstoxReq({ path: '/v2/user/get-funds-and-margin?segment=SEC' });
        if (r.status === 401) {
          log('Connection failed: HTTP 401 — Token expired. Re-enter access token.', 'ERROR');
          res.end(JSON.stringify({error:'Token expired'})); return;
        }
        const avail = r.data?.data?.equity?.available_margin || 0;
        state.capital           = Math.round(avail);
        state.config.capital    = state.capital;
        state.config.broker     = cmd.broker || 'Upstox';
        state.connected         = true;
        checkDailyReset();
        await fetchOpenPositionsOnConnect();
        await fetchQuotes();
        startLoops();
        log('Connected — NIFTY=' + (state.quotes.nifty||'?') + ' BNF=' + (state.quotes.bnf||'?') + ' | Build ' + VERSION + ' | Real orders: ENABLED ✅', 'INFO');
        log('🤖 v7.0 SERVER BRAIN ACTIVE — Tab state irrelevant. Server handles all trades, trail, SL, EOD independently.', 'SYSTEM');
        log('💰 Account balance: ₹' + state.capital.toLocaleString('en-IN') + ' available (₹' + state.capital.toLocaleString('en-IN') + ' total)', 'INFO');
        pushFullState();
        res.end(JSON.stringify({ok:true, capital:state.capital}));
      } catch(e) {
        log('Connection error: ' + e.message, 'ERROR');
        res.end(JSON.stringify({error:e.message}));
      }
      break;
    }

    case 'START_TRADING': {
      if (!state.connected) { res.end(JSON.stringify({error:'Not connected'})); return; }
      state.tradingEnabled = true;
      state.sysStatus      = 'ACTIVE';
      const risk = calcRisk(state.capital);
      const sess = getSession();
      log('▶ TRADING STARTED | Capital ₹' + state.capital.toLocaleString('en-IN') + ' | MaxPos ' + risk.maxPositions + ' | MaxTrades ' + risk.maxTrades + ' | Risk ' + risk.riskPct + '%/trade | Session ' + sess.label, 'SYSTEM');
      pushFullState();
      res.end(JSON.stringify({ok:true}));
      break;
    }

    case 'STOP_TRADING': {
      state.tradingEnabled = false;
      state.sysStatus      = 'IDLE';
      log('⏹ TRADING STOPPED | DailyPnl ' + (state.dailyPnl>=0?'+₹':'-₹') + Math.abs(state.dailyPnl) + ' | Trades ' + state.todayTrades + ' | OpenPos ' + state.openPositions.length, 'SYSTEM');
      pushFullState();
      res.end(JSON.stringify({ok:true}));
      break;
    }

    case 'UPDATE_CONFIG': {
      state.config = { ...state.config, ...(cmd.config||{}) };
      log('CONFIG UPDATED: ' + JSON.stringify(cmd.config), 'CONFIG');
      pushFullState();
      res.end(JSON.stringify({ok:true}));
      break;
    }

    case 'MANUAL_CLOSE': {
      const pos = state.openPositions.find(p => p.id === cmd.positionId);
      if (!pos) { res.end(JSON.stringify({error:'Position not found'})); return; }
      await executeSell(pos, 'MANUAL');
      res.end(JSON.stringify({ok:true}));
      break;
    }

    case 'GET_STATE': {
      res.end(JSON.stringify(getFullState()));
      break;
    }

    default:
      res.end(JSON.stringify({error:'Unknown command: ' + cmd.type}));
  }
}

// ─────────────────────────────────────────────
// LEGACY PROXY HANDLER (backward compat with old browser)
// ─────────────────────────────────────────────
async function handleProxyAction(action, payload, token) {
  const h = { 'Authorization':'Bearer '+token, 'Accept':'application/json', 'Content-Type':'application/json' };

  function req(opts, body) {
    return new Promise((resolve, reject) => {
      const options = { hostname:'api.upstox.com', port:443, method:opts.method||'GET', path:opts.path, headers:h };
      const r = https.request(options, res => {
        let d=''; res.on('data',c=>d+=c); res.on('end',()=>{try{resolve(JSON.parse(d))}catch(_){resolve(d)}});
      });
      r.on('error',reject);
      if (body) r.write(JSON.stringify(body));
      r.end();
    });
  }

  if (action==='place_order')   return req({path:'/v2/order/place',method:'POST'}, payload);
  if (action==='option_chain')  { const qs=payload.expiry_date?`instrument_key=${encodeURIComponent(payload.instrument_key)}&expiry_date=${payload.expiry_date}`:`instrument_key=${encodeURIComponent(payload.instrument_key)}`; return req({path:'/v2/option/contract?'+qs}); }
  if (action==='positions')     return req({path:'/v2/portfolio/short-term-positions'});
  if (action==='fund_margin')   return req({path:'/v2/user/get-funds-and-margin?segment=SEC'});
  if (action==='order_status')  return req({path:'/v2/order/details?order_id='+payload.order_id});
  if (action==='cancel_order')  return req({path:'/v2/order/cancel?order_id='+payload.order_id,method:'DELETE'});
  if (action==='open_orders')   return req({path:'/v2/order/retrieve-all'});
  throw new Error('Unknown action: '+action);
}

// ─────────────────────────────────────────────
// FULL STATE GETTER
// ─────────────────────────────────────────────
function getFullState() {
  return {
    version:        VERSION,
    connected:      state.connected,
    tradingEnabled: state.tradingEnabled,
    sysStatus:      state.sysStatus,
    capital:        state.capital,
    openPositions:  state.openPositions,
    trades:         state.trades.slice(0,50),
    dailyPnl:       state.dailyPnl,
    todayTrades:    state.todayTrades,
    quotes:         state.quotes,
    candles:        { nifty:state.candles.nifty.slice(-80), bnf:state.candles.bnf.slice(-80), finnifty:state.candles.finnifty.slice(-80) },
    logs:           state.logs.slice(0,300),
    config:         state.config,
    cbActive:       state.cbActive,
    opps:           state.opps.slice(0,20),
    session:        getSession(),
    session:        getSession(),
  };
}

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────
server.listen(PORT, () => {
  console.log('QuantEdge AI ' + VERSION + ' server running on port ' + PORT);
  console.log('SSE endpoint:     /stream');
  console.log('Command endpoint: /command');
  console.log('Legacy proxy:     /api/order');
  console.log('Health check:     /health');
});
