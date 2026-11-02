// AquaGuard AIoT server
// MQTT subscriber -> PostgreSQL -> live dashboard (Server-Sent Events) + CSV export.
// Run: npm install && npm start
//
// Environment variables:
//   PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE   PostgreSQL connection (or DATABASE_URL)
//   MQTT_URL    default mqtt://broker.hivemq.com:1883
//   TOPIC_BASE  default aquaguard/steven-2802941592  (must match firmware config.h)
//   PORT        default 3000
//   DASHBOARD_USER / DASHBOARD_PASSWORD  when the password is set, the dashboard needs a login
//               (sign-in page for browsers, HTTP Basic for scripts). Use this on the internet.

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const mqtt = require('mqtt');
const { Pool, types } = require('pg');

const MQTT_URL = process.env.MQTT_URL || 'mqtt://broker.hivemq.com:1883';
const TOPIC_BASE = process.env.TOPIC_BASE || 'aquaguard/steven-2802941592';
const PORT = Number(process.env.PORT || 3000);
const DASH_USER = process.env.DASHBOARD_USER || 'admin';
const DASH_PASS = process.env.DASHBOARD_PASSWORD || '';

// ---------------- Database ----------------
types.setTypeParser(20, (v) => Number(v));   // BIGINT and COUNT(*) as numbers, not strings
const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL }) : new Pool();
pool.on('error', (e) => console.error('PostgreSQL error:', e.message));
const q = (sql, params = []) => pool.query(sql, params);

const COLS = ['t_tank', 't_res', 'tds', 'tds_v', 'turb', 'turb_v', 'ph', 'ph_v', 'flow', 'vol_ml', 'f_top', 'f_bot',
  'score', 'state', 'drain', 'fill', 'feeder', 'buzzer', 'auto', 'demo', 'fault', 'ml'];
const TEXT_COLS = ['state', 'fault', 'ml'];

async function initDb() {
  await q(`
    CREATE TABLE IF NOT EXISTS readings (
      id BIGSERIAL PRIMARY KEY,
      epoch BIGINT NOT NULL,             -- server receive time (unix s)
      device_ts BIGINT,                  -- ESP32 NTP time (0 if not synced)
      t_tank DOUBLE PRECISION, t_res DOUBLE PRECISION, tds DOUBLE PRECISION, tds_v DOUBLE PRECISION,
      turb DOUBLE PRECISION, turb_v DOUBLE PRECISION, ph DOUBLE PRECISION, ph_v DOUBLE PRECISION,
      flow DOUBLE PRECISION, vol_ml DOUBLE PRECISION, f_top SMALLINT, f_bot SMALLINT,
      score SMALLINT, state TEXT, drain SMALLINT, fill SMALLINT, feeder SMALLINT,
      buzzer SMALLINT, auto SMALLINT, demo SMALLINT, fault TEXT,
      ml TEXT,                           -- prediction made on the ESP32 (decision tree)
      label TEXT,                        -- condition label set on the dashboard (for ML)
      source TEXT                        -- 'device' or 'sim'
    );
    ALTER TABLE readings ADD COLUMN IF NOT EXISTS ml TEXT;
    CREATE TABLE IF NOT EXISTS events (
      id BIGSERIAL PRIMARY KEY,
      epoch BIGINT NOT NULL, device_ts BIGINT,
      type TEXT, name TEXT, value DOUBLE PRECISION, detail TEXT, source TEXT
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE INDEX IF NOT EXISTS idx_readings_epoch ON readings(epoch);
    CREATE INDEX IF NOT EXISTS idx_events_epoch ON events(epoch);
  `);
}

// The database container may still be starting: retry for about a minute
async function waitForDb() {
  for (let i = 1; ; i++) {
    try { await initDb(); return; } catch (e) {
      if (i >= 30) throw e;
      console.log(`Waiting for PostgreSQL (${e.message})...`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

const insReading = `INSERT INTO readings (epoch, device_ts, ${COLS.join(',')}, label, source)
  VALUES (${Array.from({ length: COLS.length + 4 }, (_, i) => `$${i + 1}`).join(',')}) RETURNING id`;
const insEvent = 'INSERT INTO events (epoch, device_ts, type, name, value, detail, source) VALUES ($1,$2,$3,$4,$5,$6,$7)';
const logEvent = (...v) => q(insEvent, v).catch((e) => console.error('Event not saved:', e.message));

let currentLabel = '';
let latest = null, latestMl = null, deviceStatus = 'unknown', lastDataAt = 0;

const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const now = () => Math.floor(Date.now() / 1000);
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => { console.error(e.message); res.status(500).json({ error: 'database error' }); });

// ---------------- Live clients (SSE) ----------------
const clients = new Set();
function broadcast(type, data) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

function health() {
  return { mqtt: mqttUp, device: deviceStatus, dataFresh: Date.now() - lastDataAt < 15000, label: currentLabel, topic: TOPIC_BASE };
}

// ---------------- MQTT ----------------
let client, mqttUp = false;
function startMqtt() {
  client = mqtt.connect(MQTT_URL, { reconnectPeriod: 3000, clientId: 'aquaguard-server-' + Math.random().toString(16).slice(2, 8) });
  client.on('connect', () => {
    mqttUp = true;
    client.subscribe([`${TOPIC_BASE}/data`, `${TOPIC_BASE}/event`, `${TOPIC_BASE}/status`]);
    console.log(`MQTT connected to ${MQTT_URL}, topics ${TOPIC_BASE}/#`);
    broadcast('health', health());
  });
  client.on('close', () => { if (mqttUp) { mqttUp = false; broadcast('health', health()); } });
  client.on('error', (e) => console.error('MQTT error:', e.message));

  client.on('message', async (topic, buf) => {
    const sub = topic.slice(TOPIC_BASE.length + 1);
    const text = buf.toString();
    if (sub === 'status') { deviceStatus = text; broadcast('health', health()); return; }
    let m;
    try { m = JSON.parse(text); } catch { return; }
    const t = now();
    const source = m.src === 'sim' ? 'sim' : 'device';
    try {
      if (sub === 'data') {
        const vals = COLS.map((c) => (TEXT_COLS.includes(c) ? (m[c] ?? null) : num(m[c])));
        const label = currentLabel || null;
        const { rows } = await q(insReading, [t, num(m.ts), ...vals, label, source]);
        latest = { id: rows[0].id, epoch: t, device_ts: num(m.ts), ...Object.fromEntries(COLS.map((c, i) => [c, vals[i]])), label, source };
        lastDataAt = Date.now();
        broadcast('reading', latest);
      } else if (sub === 'event') {
        await q(insEvent, [t, num(m.ts), m.type ?? null, m.name ?? null, num(m.value), m.detail ?? null, source]);
        broadcast('event', { epoch: t, type: m.type, name: m.name, value: m.value, detail: m.detail, source });
      }
    } catch (e) {
      console.error('Message not saved:', e.message);
    }
  });
}

// ---------------- HTTP ----------------
const app = express();
app.use(express.json());

app.get('/healthz', (req, res) => res.json({ ok: true, mqtt: mqttUp }));   // used by the Docker healthcheck, no login

// ---------------- Login ----------------
// Everyone who can open the dashboard can also run the pumps, so it is protected when
// DASHBOARD_PASSWORD is set. Browsers sign in on /login and get a signed session cookie.
// Scripts (predict_live.py) may send HTTP Basic credentials instead.
const SESSION_COOKIE = 'aquaguard_session';
const SESSION_DAYS = 7;
// Key derived from the password: changing the password signs everyone out
const SESSION_KEY = crypto.createHash('sha256').update('aquaguard-session:' + DASH_USER + ':' + DASH_PASS).digest();
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const sign = (data) => crypto.createHmac('sha256', SESSION_KEY).update(data).digest('base64url');

function makeSession() {
  const data = Buffer.from(JSON.stringify({ u: DASH_USER, exp: Date.now() + SESSION_DAYS * 864e5 })).toString('base64url');
  return `${data}.${sign(data)}`;
}
function validSession(token) {
  const [data, sig] = String(token || '').split('.');
  if (!data || !sig || !same(sig, sign(data))) return false;
  try { return JSON.parse(Buffer.from(data, 'base64url').toString()).exp > Date.now(); } catch { return false; }
}
function cookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
function basicOk(req) {
  const [type, value] = (req.headers.authorization || '').split(' ');
  if (type !== 'Basic' || !value) return false;
  const text = Buffer.from(value, 'base64').toString();
  const i = text.indexOf(':');
  return i > 0 && same(text.slice(0, i), DASH_USER) && same(text.slice(i + 1), DASH_PASS);
}
const signedIn = (req) => !DASH_PASS || validSession(cookie(req, SESSION_COOKIE)) || basicOk(req);

// Slow down password guessing: 10 failed attempts per IP per 15 minutes
const failures = new Map();
function tooManyFailures(ip) {
  const f = failures.get(ip);
  if (!f || Date.now() - f.since > 15 * 60e3) { failures.delete(ip); return false; }
  return f.count >= 10;
}
function recordFailure(ip) {
  const f = failures.get(ip);
  if (!f || Date.now() - f.since > 15 * 60e3) failures.set(ip, { count: 1, since: Date.now() });
  else f.count++;
}

app.set('trust proxy', 1);   // behind Nginx: req.secure and req.ip come from X-Forwarded-* headers

app.post('/api/login', (req, res) => {
  if (!DASH_PASS) return res.json({ ok: true });
  const ip = req.ip;
  if (tooManyFailures(ip)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  const { username, password } = req.body || {};
  if (!same(username || '', DASH_USER) || !same(password || '', DASH_PASS)) {
    recordFailure(ip);
    return res.status(401).json({ error: 'Wrong username or password.' });
  }
  failures.delete(ip);
  res.cookie(SESSION_COOKIE, makeSession(), { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: SESSION_DAYS * 864e5, path: '/' });
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
});
app.get('/api/session', (req, res) => res.json({ auth: !!DASH_PASS, signedIn: signedIn(req) }));

const PUBLIC_PATHS = new Set(['/login', '/login.html', '/styles.css', '/favicon.svg']);
app.get('/login', (req, res) => (DASH_PASS && !signedIn(req)
  ? res.sendFile(path.join(__dirname, 'public', 'login.html'))
  : res.redirect('/')));
app.use((req, res, next) => {
  if (PUBLIC_PATHS.has(req.path) || signedIn(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not signed in' });
  res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
});
if (!DASH_PASS) console.warn('DASHBOARD_PASSWORD not set: dashboard has no login (fine on localhost only)');

app.use(express.static(path.join(__dirname, 'public')));
// Chart.js served locally, so the dashboard also works without internet
app.get('/vendor/chart.umd.js', (req, res) => res.sendFile(path.join(__dirname, 'node_modules', 'chart.js', 'dist', 'chart.umd.js')));

app.get('/api/latest', (req, res) => res.json({ reading: latest, ml: latestMl, health: health() }));

app.get('/api/history', wrap(async (req, res) => {
  const minutes = Math.min(Math.max(Number(req.query.minutes) || 30, 1), 60 * 24 * 30);
  const since = now() - minutes * 60;
  const maxPts = 1500;                       // thin out long ranges for the chart
  const { rows: [{ n }] } = await q('SELECT COUNT(*) AS n FROM readings WHERE epoch >= $1', [since]);
  const step = Math.max(1, Math.ceil(n / maxPts));
  const { rows } = await q(`SELECT * FROM (SELECT *, ROW_NUMBER() OVER (ORDER BY epoch) AS rn FROM readings WHERE epoch >= $1) t
    WHERE (rn - 1) % $2 = 0 ORDER BY epoch`, [since, step]);
  res.json(rows);
}));

app.get('/api/events', wrap(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  res.json((await q('SELECT * FROM events ORDER BY id DESC LIMIT $1', [limit])).rows);
}));

app.get('/api/stats', wrap(async (req, res) => {
  const { rows: [r] } = await q(`SELECT COUNT(*) AS n, MIN(epoch) AS first, MAX(epoch) AS last,
    COUNT(*) FILTER (WHERE source = 'device') AS device, COUNT(*) FILTER (WHERE source = 'sim') AS sim FROM readings`);
  const { rows: labels } = await q(`SELECT label, COUNT(*) AS n FROM readings WHERE label IS NOT NULL AND source = 'device' GROUP BY label ORDER BY label`);
  const { rows: [ev] } = await q('SELECT COUNT(*) AS n FROM events');
  res.json({ ...r, events: ev.n, labels });
}));

app.post('/api/cmd', (req, res) => {
  const { cmd } = req.body || {};
  const allowed = ['change', 'stop', 'reset', 'auto', 'demo', 'beep', 'drain', 'fill'];
  if (!allowed.includes(cmd)) return res.status(400).json({ error: 'unknown cmd' });
  if (!mqttUp) return res.status(503).json({ error: 'MQTT not connected' });
  client.publish(`${TOPIC_BASE}/cmd`, JSON.stringify(req.body));
  logEvent(now(), null, 'command', cmd, num(req.body.pct ?? req.body.sec ?? (req.body.on === undefined ? null : (req.body.on ? 1 : 0))), 'from dashboard', 'server');
  res.json({ ok: true });
});

app.post('/api/label', wrap(async (req, res) => {
  const label = String((req.body || {}).label || '').trim();
  if (label && !/^[a-z_]{1,32}$/.test(label)) return res.status(400).json({ error: 'label must be a-z or _' });
  await q('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', ['label', label]);
  currentLabel = label;
  logEvent(now(), null, 'label', label || '(none)', null, 'label changed on dashboard', 'server');
  broadcast('health', health());
  res.json({ ok: true, label });
}));

// The ML script posts its live prediction here, so the dashboard can show it
app.post('/api/ml', (req, res) => {
  latestMl = { ...req.body, epoch: now() };
  broadcast('ml', latestMl);
  res.json({ ok: true });
});

const esc = (v) => (v === null || v === undefined ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

app.get('/api/export.csv', wrap(async (req, res) => {
  const src = req.query.source ? String(req.query.source) : null;
  const { rows } = await q(`SELECT * FROM readings ${src ? 'WHERE source = $1' : ''} ORDER BY id`, src ? [src] : []);
  const head = ['id', 'timestamp_wib', 'epoch', 'device_ts', ...COLS, 'label', 'source'];
  const wib = (e) => new Date((e + 7 * 3600) * 1000).toISOString().replace('T', ' ').slice(0, 19);
  const lines = [head.join(',')];
  for (const r of rows) lines.push([r.id, wib(r.epoch), r.epoch, r.device_ts, ...COLS.map((c) => r[c]), r.label, r.source].map(esc).join(','));
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="aquaguard_dataset_${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(lines.join('\n'));
}));

app.get('/api/events.csv', wrap(async (req, res) => {
  const { rows } = await q('SELECT * FROM events ORDER BY id');
  const head = ['id', 'epoch', 'device_ts', 'type', 'name', 'value', 'detail', 'source'];
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="aquaguard_events.csv"');
  res.send([head.join(','), ...rows.map((r) => head.map((h) => esc(r[h])).join(','))].join('\n'));
}));

app.get('/api/stream', (req, res) => {
  // X-Accel-Buffering: no stops Nginx from holding back the live events
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write(`event: health\ndata: ${JSON.stringify(health())}\n\n`);
  if (latest) res.write(`event: reading\ndata: ${JSON.stringify(latest)}\n\n`);
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

// ---------------- Start ----------------
(async () => {
  await waitForDb();
  const { rows } = await q('SELECT value FROM settings WHERE key = $1', ['label']);
  currentLabel = rows[0]?.value || '';
  startMqtt();
  setInterval(() => broadcast('health', health()), 5000);
  app.listen(PORT, () => console.log(`Dashboard: http://localhost:${PORT}`));
})().catch((e) => { console.error('Startup failed:', e.message); process.exit(1); });
