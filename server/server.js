// AquaGuard AIoT server
// MQTT subscriber -> SQLite (node:sqlite) -> live dashboard (Server-Sent Events) + CSV export.
// Run: npm install && npm start   (Node.js 22.13 or newer)
//
// Environment variables (all optional):
//   MQTT_URL    default mqtt://broker.hivemq.com:1883
//   TOPIC_BASE  default aquaguard/steven-2802941592  (must match firmware config.h)
//   PORT        default 3000
//   DB_FILE     default aquaguard.db
//   DASHBOARD_USER / DASHBOARD_PASSWORD  when the password is set, the whole dashboard and API
//               require HTTP Basic login (use this when the dashboard is on the internet)

const path = require('path');
const express = require('express');
const mqtt = require('mqtt');
const { DatabaseSync } = require('node:sqlite');

const MQTT_URL = process.env.MQTT_URL || 'mqtt://broker.hivemq.com:1883';
const TOPIC_BASE = process.env.TOPIC_BASE || 'aquaguard/steven-2802941592';
const PORT = Number(process.env.PORT || 3000);
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'aquaguard.db');
const DASH_USER = process.env.DASHBOARD_USER || 'admin';
const DASH_PASS = process.env.DASHBOARD_PASSWORD || '';

// ---------------- Database ----------------
const db = new DatabaseSync(DB_FILE);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    epoch INTEGER NOT NULL,          -- server receive time (unix s)
    device_ts INTEGER,               -- ESP32 NTP time (0 if not synced)
    t_tank REAL, t_res REAL, tds REAL, tds_v REAL, turb REAL, turb_v REAL,
    ph REAL, ph_v REAL, flow REAL, vol_ml REAL, f_top INTEGER, f_bot INTEGER,
    score INTEGER, state TEXT, drain INTEGER, fill INTEGER, feeder INTEGER,
    buzzer INTEGER, auto INTEGER, demo INTEGER, fault TEXT,
    ml TEXT,                         -- prediction made on the ESP32 (decision tree)
    label TEXT,                      -- condition label set on the dashboard (for ML)
    source TEXT                      -- 'device' or 'sim'
  );
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    epoch INTEGER NOT NULL, device_ts INTEGER,
    type TEXT, name TEXT, value REAL, detail TEXT, source TEXT
  );
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
  CREATE INDEX IF NOT EXISTS idx_readings_epoch ON readings(epoch);
  CREATE INDEX IF NOT EXISTS idx_events_epoch ON events(epoch);
`);

// Databases created before the on-device model existed get the new column
if (!db.prepare('PRAGMA table_info(readings)').all().some((c) => c.name === 'ml')) db.exec('ALTER TABLE readings ADD COLUMN ml TEXT');

const COLS = ['t_tank', 't_res', 'tds', 'tds_v', 'turb', 'turb_v', 'ph', 'ph_v', 'flow', 'vol_ml', 'f_top', 'f_bot',
  'score', 'state', 'drain', 'fill', 'feeder', 'buzzer', 'auto', 'demo', 'fault', 'ml'];
const TEXT_COLS = ['state', 'fault', 'ml'];
const insReading = db.prepare(`INSERT INTO readings (epoch, device_ts, ${COLS.join(',')}, label, source)
  VALUES (?, ?, ${COLS.map(() => '?').join(',')}, ?, ?)`);
const insEvent = db.prepare(`INSERT INTO events (epoch, device_ts, type, name, value, detail, source) VALUES (?,?,?,?,?,?,?)`);
const getSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
const setSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');

let currentLabel = (getSetting.get('label') || {}).value || '';
let latest = null, latestMl = null, deviceStatus = 'unknown', lastDataAt = 0;

const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const now = () => Math.floor(Date.now() / 1000);

// ---------------- Live clients (SSE) ----------------
const clients = new Set();
function broadcast(type, data) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

// ---------------- MQTT ----------------
const client = mqtt.connect(MQTT_URL, { reconnectPeriod: 3000, clientId: 'aquaguard-server-' + Math.random().toString(16).slice(2, 8) });
let mqttUp = false;
client.on('connect', () => {
  mqttUp = true;
  client.subscribe([`${TOPIC_BASE}/data`, `${TOPIC_BASE}/event`, `${TOPIC_BASE}/status`]);
  console.log(`MQTT connected to ${MQTT_URL}, topics ${TOPIC_BASE}/#`);
  broadcast('health', health());
});
client.on('close', () => { if (mqttUp) { mqttUp = false; broadcast('health', health()); } });
client.on('error', (e) => console.error('MQTT error:', e.message));

client.on('message', (topic, buf) => {
  const sub = topic.slice(TOPIC_BASE.length + 1);
  const text = buf.toString();
  if (sub === 'status') { deviceStatus = text; broadcast('health', health()); return; }
  let m;
  try { m = JSON.parse(text); } catch { return; }
  const t = now();
  const source = m.src === 'sim' ? 'sim' : 'device';
  if (sub === 'data') {
    const vals = COLS.map((c) => (TEXT_COLS.includes(c) ? (m[c] ?? null) : num(m[c])));
    const info = insReading.run(t, num(m.ts), ...vals, currentLabel || null, source);
    latest = { id: Number(info.lastInsertRowid), epoch: t, device_ts: num(m.ts), ...Object.fromEntries(COLS.map((c, i) => [c, vals[i]])), label: currentLabel || null, source };
    lastDataAt = Date.now();
    broadcast('reading', latest);
  } else if (sub === 'event') {
    insEvent.run(t, num(m.ts), m.type ?? null, m.name ?? null, num(m.value), m.detail ?? null, source);
    broadcast('event', { epoch: t, type: m.type, name: m.name, value: m.value, detail: m.detail, source });
  }
});

function health() {
  return { mqtt: mqttUp, device: deviceStatus, dataFresh: Date.now() - lastDataAt < 15000, label: currentLabel, topic: TOPIC_BASE };
}

// ---------------- HTTP ----------------
const app = express();
app.use(express.json());

app.get('/healthz', (req, res) => res.json({ ok: true, mqtt: mqttUp }));   // used by the Docker healthcheck, no login

// Optional login: everyone who can open the dashboard can also run the pumps,
// so protect it with a password when it is reachable from the internet.
const crypto = require('crypto');
const same = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
if (DASH_PASS) {
  app.use((req, res, next) => {
    const [type, value] = (req.headers.authorization || '').split(' ');
    if (type === 'Basic' && value) {
      const text = Buffer.from(value, 'base64').toString();
      const i = text.indexOf(':');
      if (i > 0 && same(text.slice(0, i), DASH_USER) && same(text.slice(i + 1), DASH_PASS)) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="AquaGuard"').status(401).send('Login required');
  });
} else {
  console.warn('DASHBOARD_PASSWORD not set: dashboard has no login (fine on localhost only)');
}
app.use(express.static(path.join(__dirname, 'public')));
// Chart.js served locally, so the dashboard also works without internet
app.get('/vendor/chart.umd.js', (req, res) => res.sendFile(path.join(__dirname, 'node_modules', 'chart.js', 'dist', 'chart.umd.js')));

app.get('/api/latest', (req, res) => res.json({ reading: latest, ml: latestMl, health: health() }));

app.get('/api/history', (req, res) => {
  const minutes = Math.min(Math.max(Number(req.query.minutes) || 30, 1), 60 * 24 * 30);
  const since = now() - minutes * 60;
  let rows = db.prepare('SELECT * FROM readings WHERE epoch >= ? ORDER BY epoch').all(since);
  const maxPts = 1500;                       // thin out long ranges for the chart
  if (rows.length > maxPts) { const step = Math.ceil(rows.length / maxPts); rows = rows.filter((_, i) => i % step === 0); }
  res.json(rows);
});

app.get('/api/events', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  res.json(db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit));
});

app.get('/api/stats', (req, res) => {
  const r = db.prepare(`SELECT COUNT(*) AS n, MIN(epoch) AS first, MAX(epoch) AS last,
    SUM(source = 'device') AS device, SUM(source = 'sim') AS sim FROM readings`).get();
  const labels = db.prepare(`SELECT label, COUNT(*) AS n FROM readings WHERE label IS NOT NULL AND source = 'device' GROUP BY label`).all();
  const ev = db.prepare('SELECT COUNT(*) AS n FROM events').get();
  res.json({ ...r, events: ev.n, labels });
});

app.post('/api/cmd', (req, res) => {
  const { cmd } = req.body || {};
  const allowed = ['change', 'stop', 'reset', 'auto', 'demo', 'beep', 'drain', 'fill'];
  if (!allowed.includes(cmd)) return res.status(400).json({ error: 'unknown cmd' });
  if (!mqttUp) return res.status(503).json({ error: 'MQTT not connected' });
  client.publish(`${TOPIC_BASE}/cmd`, JSON.stringify(req.body));
  insEvent.run(now(), null, 'command', cmd, num(req.body.pct ?? req.body.sec ?? (req.body.on === undefined ? null : (req.body.on ? 1 : 0))), 'from dashboard', 'server');
  res.json({ ok: true });
});

app.post('/api/label', (req, res) => {
  const label = String((req.body || {}).label || '').trim();
  if (label && !/^[a-z_]{1,32}$/.test(label)) return res.status(400).json({ error: 'label must be a-z or _' });
  currentLabel = label;
  setSetting.run('label', label);
  insEvent.run(now(), null, 'label', label || '(none)', null, 'label changed on dashboard', 'server');
  broadcast('health', health());
  res.json({ ok: true, label });
});

// The ML script posts its live prediction here, so the dashboard can show it
app.post('/api/ml', (req, res) => {
  latestMl = { ...req.body, epoch: now() };
  broadcast('ml', latestMl);
  res.json({ ok: true });
});

app.get('/api/export.csv', (req, res) => {
  const where = req.query.source ? 'WHERE source = ?' : '';
  const args = req.query.source ? [String(req.query.source)] : [];
  const rows = db.prepare(`SELECT * FROM readings ${where} ORDER BY id`).all(...args);
  const head = ['id', 'timestamp_wib', 'epoch', 'device_ts', ...COLS, 'label', 'source'];
  const wib = (e) => new Date((e + 7 * 3600) * 1000).toISOString().replace('T', ' ').slice(0, 19);
  const esc = (v) => (v === null || v === undefined ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const lines = [head.join(',')];
  for (const r of rows) lines.push([r.id, wib(r.epoch), r.epoch, r.device_ts, ...COLS.map((c) => r[c]), r.label, r.source].map(esc).join(','));
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="aquaguard_dataset_${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(lines.join('\n'));
});

app.get('/api/events.csv', (req, res) => {
  const rows = db.prepare('SELECT * FROM events ORDER BY id').all();
  const head = ['id', 'epoch', 'device_ts', 'type', 'name', 'value', 'detail', 'source'];
  const esc = (v) => (v === null || v === undefined ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="aquaguard_events.csv"');
  res.send([head.join(','), ...rows.map((r) => head.map((h) => esc(r[h])).join(','))].join('\n'));
});

app.get('/api/stream', (req, res) => {
  // X-Accel-Buffering: no stops Nginx from holding back the live events
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write(`event: health\ndata: ${JSON.stringify(health())}\n\n`);
  if (latest) res.write(`event: reading\ndata: ${JSON.stringify(latest)}\n\n`);
  clients.add(res);
  req.on('close', () => clients.delete(res));
});
setInterval(() => broadcast('health', health()), 5000);

app.listen(PORT, () => console.log(`Dashboard: http://localhost:${PORT}`));
