// Fake ESP32 for testing the dashboard without hardware.
// Publishes readings and events in the same format as the firmware and obeys dashboard commands.
// Usage: node tools/simulate.js [--interval 3000] [--speed 1]
const mqtt = require('mqtt');

const MQTT_URL = process.env.MQTT_URL || 'mqtt://broker.hivemq.com:1883';
const TOPIC_BASE = process.env.TOPIC_BASE || 'iot-project/steven-2802941592';

const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  return Number(args[index + 1]) || fallback;
}
const INTERVAL = option('--interval', 3000);   // ms between readings
const SPEED = option('--speed', 1);            // >1 makes the water get dirty faster

// Same thresholds as the firmware's config.h
const TURB_V_CLEAR = 3.87;
const TDS_GOOD = 300;
const TDS_BAD = 700;
const SCORE_THRESHOLD = 60;
const COOLDOWN_MS = 30 * 60 * 1000;   // wait after a water change before R1 may fire again
const LOW_READINGS_TO_ACT = 5;

// Simulated tank: level 1 = top float, LOW_LEVEL = bottom float
const LEVEL_PER_SEC = 0.003;
const LOW_LEVEL = 0.75;

// Water and device state
let dirt = 0;   // 0 = fresh water, 1 = very dirty
let tds = 220;
let turbV = 3.85;
let temp = 26.5;
let level = 1;
let state = 'idle';
let auto = 1;
let drain = 0;
let fill = 0;
let lowCount = 0;
let cooldownUntil = 0;

const client = mqtt.connect(MQTT_URL, {
  will: { topic: `${TOPIC_BASE}/status`, payload: 'offline', retain: true },
});

// Publishes to TOPIC_BASE/<sub>; only the online/offline status is retained
function publish(sub, payload) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  client.publish(`${TOPIC_BASE}/${sub}`, text, { retain: sub === 'status' });
}

function unixTime() {
  return Math.floor(Date.now() / 1000);
}

function sendEvent(type, name, value, detail) {
  publish('event', { ts: unixTime(), src: 'sim', type, name, value, detail });
}

// 100 at the good value, 0 at the bad value, linear in between (same as the firmware)
function lin(value, good, bad) {
  const t = Math.min(Math.max((value - good) / (bad - good), 0), 1);
  return 100 * (1 - t);
}

// Same weighted health score as computeScore() in the firmware
function healthScore(turbIdx) {
  const tdsScore = lin(tds, TDS_GOOD, TDS_BAD);
  const turbScore = 100 - turbIdx;

  let tempScore = 100;
  if (temp < 24) tempScore = lin(temp, 24, 20);
  else if (temp > 30) tempScore = lin(temp, 30, 34);

  return Math.round(0.5 * tdsScore + 0.375 * turbScore + 0.125 * tempScore);
}

function startChange(why) {
  if (state !== 'idle') return;
  state = 'draining';
  drain = 1;
  sendEvent('state', 'draining', 0, why);
  sendEvent('actuator', 'drain', 1, why);
}

function updateTank(seconds) {
  if (state === 'draining') {
    level = Math.max(level - LEVEL_PER_SEC * seconds, LOW_LEVEL);
    if (level <= LOW_LEVEL) {
      drain = 0;
      sendEvent('actuator', 'drain', 0, 'bottom float');
      state = 'filling';
      fill = 1;
      sendEvent('state', 'filling', 0, 'refill until top float');
      sendEvent('actuator', 'fill', 1, 'refill');
    }
  } else if (state === 'filling') {
    level = Math.min(level + LEVEL_PER_SEC * seconds, 1);
    if (level >= 1) {
      fill = 0;
      dirt *= LOW_LEVEL;   // part of the dirty water was replaced
      state = 'idle';
      cooldownUntil = Date.now() + COOLDOWN_MS / SPEED;
      sendEvent('actuator', 'fill', 0, 'top float');
      sendEvent('state', 'idle', 0, 'change done');
      lowCount = 0;
    }
  }
}

client.on('connect', () => {
  console.log(`Simulator connected to ${MQTT_URL}, publishing to ${TOPIC_BASE}/data every ${INTERVAL} ms`);
  publish('status', 'online');
  client.subscribe(`${TOPIC_BASE}/cmd`);
});

client.on('message', (topic, payload) => {
  let message;
  try {
    message = JSON.parse(payload.toString());
  } catch {
    return;
  }
  const { cmd } = message;

  if (cmd === 'change') startChange('manual change');

  if (cmd === 'stop') {
    drain = 0;
    fill = 0;
    state = 'idle';
    sendEvent('state', 'idle', 0, cmd);
  }

  if (cmd === 'auto') {
    auto = message.on ? 1 : 0;
    sendEvent('mode', 'auto', auto, '');
  }

  if (cmd === 'beep') sendEvent('actuator', 'buzzer', 1, 'beep');

  // Timed pump test: run for message.sec seconds (default 3, max 30)
  if ((cmd === 'drain' || cmd === 'fill') && state === 'idle') {
    const seconds = Math.min(message.sec || 3, 30);
    drain = cmd === 'drain' ? 1 : 0;
    fill = cmd === 'fill' ? 1 : 0;
    sendEvent('actuator', cmd, 1, 'manual test');

    setTimeout(() => {
      if (cmd === 'drain') drain = 0;
      else fill = 0;
      sendEvent('actuator', cmd, 0, 'manual end');
    }, seconds * 1000);
  }
});

setInterval(() => {
  const seconds = (INTERVAL / 1000) * SPEED;

  // Water slowly gets dirtier; the sensors follow with a little noise
  dirt = Math.min(dirt + 0.004 * seconds * (1 + Math.random()), 1);
  tds = 220 + 520 * dirt + (Math.random() - 0.5) * 6;
  turbV = TURB_V_CLEAR - 1.6 * dirt + (Math.random() - 0.5) * 0.02;
  temp += (Math.random() - 0.5) * 0.05;

  updateTank(seconds);

  const turbIdx = Math.min(Math.max(((TURB_V_CLEAR - turbV) / 1.5) * 100, 0), 100);
  const score = healthScore(turbIdx);

  // R1: score below the threshold for several readings in a row starts a water change
  lowCount = score < SCORE_THRESHOLD ? lowCount + 1 : 0;
  const cooling = Date.now() < cooldownUntil;
  if (auto && state === 'idle' && !cooling && lowCount >= LOW_READINGS_TO_ACT) {
    sendEvent('rule', 'R1', score, `score below ${SCORE_THRESHOLD} for ${LOW_READINGS_TO_ACT} readings`);
    startChange('auto R1');
  }

  publish('data', {
    ts: unixTime(),
    src: 'sim',
    t_tank: +temp.toFixed(2),
    tds: +tds.toFixed(1),
    tds_v: +(tds / 400).toFixed(3),
    turb: +turbIdx.toFixed(1),
    turb_v: +turbV.toFixed(3),
    f_top: level >= 1 ? 1 : 0,
    f_bot: level <= LOW_LEVEL ? 1 : 0,
    score,
    state,
    drain,
    fill,
    buzzer: 0,
    auto,
  });
}, INTERVAL);
