// server.js — API Tài Xỉu (chạy: node server.js)
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'taixiu_data.json');

let state = {
  sessions: [],
  current_session: '',
  last_prediction: '',
  last_updated: '',
  data_source_url: '',
  strategy: { analysis_window: 10, balance_threshold: 6 },
};

if (fs.existsSync(DATA_FILE)) {
  try { Object.assign(state, JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))); } catch(e){}
}
const save = () => { try { fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2)); } catch(e){} };

function calcType(dice) {
  if (!Array.isArray(dice) || dice.length !== 3) return 'unknown';
  return dice.reduce((a,b)=>a+Number(b),0) >= 11 ? 'tai' : 'xiu';
}

function predict() {
  const w = state.sessions.slice(-state.strategy.analysis_window);
  if (!w.length) return '';
  let tai = 0, xiu = 0;
  w.forEach(s => s.type === 'tai' ? tai++ : xiu++);
  if (tai >= state.strategy.balance_threshold) return 'XIU';
  if (xiu >= state.strategy.balance_threshold) return 'TAI';
  return tai > xiu ? 'TAI' : 'XIU';
}

function addSession(dice, session) {
  if (!Array.isArray(dice) || dice.length !== 3) return null;
  dice = dice.map(Number);
  if (dice.some(n => n < 1 || n > 6)) return null;
  const sum = dice.reduce((a,b)=>a+b,0);
  const rec = {
    session: String(session || Date.now()),
    dice, sum, type: sum >= 11 ? 'tai' : 'xiu',
    ts: new Date().toISOString(),
  };
  if (state.sessions.some(s => s.session === rec.session)) return rec;
  state.sessions.push(rec);
  if (state.sessions.length > 1000) state.sessions = state.sessions.slice(-1000);
  state.current_session = rec.session;
  state.last_updated = rec.ts;
  state.last_prediction = predict();
  save();
  return rec;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...CORS });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise(resolve => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const p = parsed.pathname;
  const q = parsed.query;

  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }

  if (p === '/api/health') {
    return json(res, { status: 'running', time: new Date().toISOString() });
  }

  if (p === '/api/config') {
    const last = state.sessions[state.sessions.length - 1] || null;
    return json(res, {
      game_info: {
        current_session: state.current_session,
        data_source_url: state.data_source_url,
        dice_history: state.sessions.slice(-20).map(s => s.dice),
        game_url: 'https://play-sunwin.agency',
        last_result: last,
      },
      strategy_params: state.strategy,
      system_status: {
        last_prediction: state.last_prediction,
        last_updated: state.last_updated,
        total_sessions: state.sessions.length,
      },
    });
  }

  if (p === '/api/history') {
    const limit = Math.min(Number(q.limit) || 50, 200);
    return json(res, state.sessions.slice(-limit));
  }

  if (p === '/api/predict') {
    return json(res, {
      prediction: state.last_prediction || predict(),
      current_session: state.current_session,
      based_on: state.sessions.length,
      time: new Date().toISOString(),
    });
  }

  if ((p === '/api/webhook' || p === '/api/update') && req.method === 'POST') {
    const body = await readBody(req);
    const dice = body.dice || body.result || body.xuc_xac;
    const session = body.session || body.id || body.ma_phien;
    const rec = addSession(dice, session);
    if (!rec) return json(res, { error: 'Invalid dice (need 3 numbers 1-6)' }, 400);
    return json(res, { success: true, record: rec, prediction: state.last_prediction });
  }

  if (p === '/api/fetch' && req.method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    const sourceUrl = body.url || q.url || state.data_source_url;
    if (!sourceUrl) return json(res, { error: 'Missing url' }, 400);
    try {
      const r = await fetch(sourceUrl);
      const txt = await r.text();
      let data; try { data = JSON.parse(txt); } catch { data = txt; }
      const dice = data?.dice || data?.result || data?.xuc_xac || data?.dices || data?.numbers;
      const session = data?.session || data?.id || data?.ma_phien || data?.period || data?.issue;
      if (Array.isArray(dice) && dice.length === 3) {
        const rec = addSession(dice, session);
        return json(res, { success: true, record: rec });
      }
      return json(res, { success: false, raw: String(txt).slice(0, 500) });
    } catch (e) {
      return json(res, { error: e.message }, 500);
    }
  }

  if (p === '/api/source' && req.method === 'POST') {
    const body = await readBody(req);
    state.data_source_url = body.url || '';
    save();
    return json(res, { success: true, url: state.data_source_url });
  }

  if (p === '/api/reset' && req.method === 'POST') {
    state.sessions = [];
    state.current_session = '';
    state.last_prediction = '';
    state.last_updated = '';
    save();
    return json(res, { success: true });
  }

  json(res, { error: 'Not found', path: p }, 404);
});

server.listen(PORT, () => {
  console.log(`🎲 API server chạy: http://localhost:${PORT}`);
  console.log(`   GET  /api/health | /api/config | /api/history | /api/predict`);
  console.log(`   POST /api/webhook  {dice:[1,2,3], session:"123"}`);
  console.log(`   POST /api/update   {dice:[1,2,3]}`);
  console.log(`   POST /api/fetch?url=...`);
  console.log(`   POST /api/source   {url:"..."}`);
});
