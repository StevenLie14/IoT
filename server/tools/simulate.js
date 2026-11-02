// AquaGuard simulator: a fake ESP32 for testing the server and dashboard without hardware.
// Every message carries "src":"sim", and the server stores those rows with source = 'sim',
// so simulated data never mixes with real device data in the CSV export (?source=device).
//
// Usage: node tools/simulate.js [--interval 5000] [--speed 1]
//   --speed N runs simulated time N times faster (for quick tests of the automation)
// Env:   MQTT_URL, TOPIC_BASE (same as the server)

const mqtt = require('mqtt');
const MQTT_URL = process.env.MQTT_URL || 'mqtt://broker.hivemq.com:1883';
const TOPIC_BASE = process.env.TOPIC_BASE || 'aquaguard/steven-2802941592';
const args = process.argv.slice(2);
const opt = (name, def) => (args.includes(name) ? Number(args[args.indexOf(name) + 1]) || def : def);
const INTERVAL = opt('--interval', 5000);
const SPEED = opt('--speed', 1);

const TURB_V_CLEAR = 3.87, TDS_GOOD = 300, TDS_BAD = 700, TANK_ML = 7000, ML_PER_SEC = 15.8;
let tds = 220, turbV = 3.85, temp = 26.5, dirt = 0;   // dirt rises slowly, like an unchanged tank
let state = 'idle', auto = 1, demo = 0, lowCount = 0, pct = 0, target = 0, drained = 0, filled = 0;
let cooldownUntil = 0, drain = 0, fill = 0;

const c = mqtt.connect(MQTT_URL, { will: { topic: `${TOPIC_BASE}/status`, payload: 'offline', retain: true } });
const pub = (sub, obj) => c.publish(`${TOPIC_BASE}/${sub}`, typeof obj === 'string' ? obj : JSON.stringify(obj), { retain: sub === 'status' });
const ts = () => Math.floor(Date.now() / 1000);
const event = (type, name, value, detail) => pub('event', { ts: ts(), src: 'sim', type, name, value, detail });
const lin = (v, g, b) => 100 * (1 - Math.min(Math.max((v - g) / (b - g), 0), 1));

function score(turbIdx) {
  const sT = lin(tds, TDS_GOOD, TDS_BAD), sU = 100 - turbIdx;
  const sC = temp >= 24 && temp <= 30 ? 100 : temp < 24 ? lin(temp, 24, 20) : lin(temp, 30, 34);
  return Math.round((0.4 * sT + 0.3 * sU + 0.1 * sC) / 0.8);
}

function startChange(p, why) {
  if (state !== 'idle') return;
  pct = p; target = TANK_ML * p / 100; drained = filled = 0;
  state = 'draining'; drain = 1; event('state', 'draining', p, why); event('actuator', 'drain', 1, why);
}

c.on('connect', () => {
  console.log(`Simulator connected to ${MQTT_URL}, publishing to ${TOPIC_BASE}/data every ${INTERVAL} ms`);
  pub('status', 'online');
  c.subscribe(`${TOPIC_BASE}/cmd`);
});
c.on('message', (t, b) => {
  let m; try { m = JSON.parse(b.toString()); } catch { return; }
  if (m.cmd === 'change') startChange(m.pct || 20, 'manual change');
  if (m.cmd === 'stop' || m.cmd === 'reset') { drain = fill = 0; state = 'idle'; event('state', 'idle', 0, m.cmd); }
  if (m.cmd === 'auto') { auto = m.on ? 1 : 0; event('mode', 'auto', auto, ''); }
  if (m.cmd === 'demo') { demo = m.on ? 1 : 0; event('mode', 'demo', demo, ''); }
  if (m.cmd === 'beep') event('actuator', 'buzzer', 1, 'beep');
});

setInterval(() => {
  const dt = INTERVAL / 1000 * SPEED;
  // water slowly gets dirtier; noise on every sensor
  dirt = Math.min(dirt + 0.004 * dt * (1 + Math.random()), 1);
  tds = 220 + 520 * dirt + (Math.random() - 0.5) * 6;
  turbV = TURB_V_CLEAR - 1.6 * dirt + (Math.random() - 0.5) * 0.02;
  temp += (Math.random() - 0.5) * 0.05;

  if (state === 'draining') { drained += ML_PER_SEC * dt; if (drained >= target) { drain = 0; event('actuator', 'drain', 0, 'target reached'); state = 'filling'; fill = 1; event('state', 'filling', pct, 'refill'); event('actuator', 'fill', 1, 'refill'); } }
  else if (state === 'filling') { filled += ML_PER_SEC * dt; if (filled >= drained) { fill = 0; dirt *= 1 - pct / 100; state = 'idle'; cooldownUntil = Date.now() + (demo ? 60000 : 1800000) / SPEED; event('actuator', 'fill', 0, 'refill done'); event('state', 'idle', pct, `change done ${pct}%`); lowCount = 0; } }

  const turbIdx = Math.min(Math.max((TURB_V_CLEAR - turbV) / 1.5 * 100, 0), 100);
  const s = score(turbIdx);
  lowCount = s < 60 ? lowCount + 1 : 0;
  if (auto && state === 'idle' && Date.now() > cooldownUntil && lowCount >= 3) {
    const p = s < 40 ? 30 : s < 50 ? 20 : 10;
    event('rule', 'R1', s, `score low 3x -> ${p}%`);
    startChange(p, 'auto R1');
  }
  pub('data', { ts: ts(), src: 'sim', t_tank: +temp.toFixed(2), t_res: null, tds: +tds.toFixed(1), tds_v: +(tds / 400).toFixed(3),
    turb: +turbIdx.toFixed(1), turb_v: +turbV.toFixed(3), ph: null, ph_v: null, flow: drain ? +(ML_PER_SEC * 0.06).toFixed(2) : 0,
    vol_ml: Math.round(drained), f_top: 0, f_bot: 0, score: s, state, drain, fill, feeder: 0, buzzer: 0, auto, demo, fault: '' });
}, INTERVAL);
