// AquaGuard dashboard client
const $ = (id) => document.getElementById(id);
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const fmt = (v, d = 1) => (v === null || v === undefined || Number.isNaN(Number(v)) ? '--' : Number(v).toFixed(d));
const clock = (e) => new Date(e * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const LABEL_NAMES = { clear: 'Clear', slightly_turbid: 'Slightly turbid', dirty: 'Dirty' };
const TARGET_ROWS = 1000;

let last = null;
let lastAt = 0;
let lastChange = null;

// ---------- API ----------
async function api(path, opts = {}) {
  const res = await fetch(path, { credentials: 'same-origin', ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  if (res.status === 401) { location.href = '/login?next=' + encodeURIComponent(location.pathname); throw new Error('signed out'); }
  const body = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) throw new Error(body?.error || res.statusText);
  return body;
}

// ---------- Charts ----------
const C = {
  ink2: css('--ink-2'), ink3: css('--ink-3'), line: css('--line-2'),
  accent: css('--accent'), ok: css('--ok'), warn: css('--warn'), bad: css('--bad'),
};
Chart.defaults.font.family = css('--sans');
Chart.defaults.font.size = 11;
Chart.defaults.color = C.ink3;

function lineChart(id, sets, opts = {}) {
  return new Chart($(id), {
    type: 'line',
    data: { labels: [], datasets: sets.map((s) => ({ data: [], borderWidth: 1.6, pointRadius: 0, tension: 0.25, ...s })) },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false, normalized: true,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: false }, tooltip: { backgroundColor: css('--ink'), titleFont: { weight: '500' }, padding: 8, cornerRadius: 4, boxPadding: 4 } },
      scales: {
        x: { grid: { display: false }, border: { color: C.line }, ticks: { maxTicksLimit: 6, maxRotation: 0, autoSkipPadding: 24 } },
        y: { grid: { color: C.line }, border: { display: false }, ticks: { maxTicksLimit: 5 }, ...(opts.y || {}) },
        ...(opts.y1 ? { y1: { position: 'right', grid: { display: false }, border: { display: false }, ticks: { maxTicksLimit: 5 }, ...opts.y1 } } : {}),
      },
    },
  });
}

const charts = {
  score: lineChart('cScore', [
    { label: 'Score', borderColor: C.ok, yAxisID: 'y1' },
    { label: 'TDS (ppm)', borderColor: C.ink2, yAxisID: 'y' },
  ], { y1: { min: 0, max: 100 } }),
  turb: lineChart('cTurb', [
    { label: 'Index', borderColor: C.warn, yAxisID: 'y1' },
    { label: 'Sensor (V)', borderColor: C.ink3, yAxisID: 'y', borderDash: [3, 3] },
  ], { y1: { min: 0, max: 100 } }),
  temp: lineChart('cTemp', [
    { label: 'Tank (°C)', borderColor: C.bad },
    { label: 'Reservoir (°C)', borderColor: C.accent },
  ]),
  pump: lineChart('cPump', [
    { label: 'Drain', borderColor: C.bad, backgroundColor: C.bad + '22', fill: true, stepped: true, tension: 0 },
    { label: 'Fill', borderColor: C.accent, backgroundColor: C.accent + '22', fill: true, stepped: true, tension: 0 },
  ], { y: { min: 0, max: 1.2, ticks: { stepSize: 1, callback: (v) => (v === 1 ? 'on' : v === 0 ? 'off' : '') } } }),
};
const rowValues = (r) => ({ score: [r.score, r.tds], turb: [r.turb, r.turb_v], temp: [r.t_tank, r.t_res], pump: [r.drain, r.fill] });

function addRow(r, trim = true) {
  const v = rowValues(r);
  for (const [k, c] of Object.entries(charts)) {
    c.data.labels.push(clock(r.epoch));
    c.data.datasets.forEach((d, i) => d.data.push(v[k][i]));
    if (trim && c.data.labels.length > 1500) { c.data.labels.shift(); c.data.datasets.forEach((d) => d.data.shift()); }
  }
}

let rangeMin = 30;
async function loadHistory() {
  const rows = await api('/api/history?minutes=' + rangeMin);
  for (const c of Object.values(charts)) { c.data.labels = []; c.data.datasets.forEach((d) => (d.data = [])); }
  rows.forEach((r) => addRow(r, false));
  Object.values(charts).forEach((c) => c.update());
  rows.slice(-60).forEach(pushSpark);
  drawSparks();
}

// ---------- Sparklines ----------
const spark = { temp: [], tds: [], turb: [], vol: [] };
const sparkEls = { temp: 'spTemp', tds: 'spTds', turb: 'spTurb', vol: 'spVol' };
function pushSpark(r) {
  const v = { temp: r.t_tank, tds: r.tds, turb: r.turb, vol: r.vol_ml };
  for (const k in spark) { spark[k].push(v[k]); if (spark[k].length > 60) spark[k].shift(); }
}
function drawSparks() {
  for (const [k, id] of Object.entries(sparkEls)) {
    const cv = $(id), dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth, h = cv.clientHeight;
    if (!w) continue;
    cv.width = w * dpr; cv.height = h * dpr;
    const ctx = cv.getContext('2d'); ctx.scale(dpr, dpr); ctx.clearRect(0, 0, w, h);
    const pts = spark[k].filter((v) => v !== null && v !== undefined);
    if (pts.length < 2) continue;
    let min = Math.min(...pts), max = Math.max(...pts);
    if (max - min < 1e-6) { min -= 1; max += 1; }
    ctx.strokeStyle = C.ink3; ctx.lineWidth = 1.2; ctx.beginPath();
    pts.forEach((v, i) => {
      const x = (i / (pts.length - 1)) * (w - 2) + 1;
      const y = h - 2 - ((v - min) / (max - min)) * (h - 4);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.stroke();
  }
}
window.addEventListener('resize', drawSparks);

// ---------- Readings ----------
function scoreClass(s) { return s >= 80 ? 'ok' : s >= 60 ? 'warn' : 'bad'; }
function scoreWord(s) { return s >= 80 ? 'Good' : s >= 60 ? 'Fair' : 'Poor, change due'; }

function setActuator(id, on, text) {
  const el = $(id);
  el.classList.toggle('on', !!on);
  el.querySelector('b').textContent = text ?? (on ? 'On' : 'Off');
}

function showReading(r) {
  last = r; lastAt = Date.now();
  const s = r.score;
  const panel = $('scorePanel');
  panel.classList.remove('ok', 'warn', 'bad');
  if (s !== null && s !== undefined) {
    panel.classList.add(scoreClass(s));
    $('score').textContent = s;
    $('scoreWord').textContent = scoreWord(s);
    $('meter').style.width = Math.max(0, Math.min(100, s)) + '%';
  }
  $('stateText').textContent = r.state || '--';
  $('kvAuto').textContent = r.auto ? (r.demo ? 'On, demo timing' : 'On') : 'Off';
  $('kvSource').textContent = r.source === 'sim' ? 'Simulator' : 'ESP32';

  $('temp').textContent = fmt(r.t_tank);
  $('tempSub').textContent = r.t_res === null || r.t_res === undefined ? 'reservoir not fitted' : `reservoir ${fmt(r.t_res)} °C`;
  $('tds').textContent = fmt(r.tds, 0);
  $('tdsSub').textContent = `probe ${fmt(r.tds_v, 3)} V`;
  $('turb').textContent = fmt(r.turb, 0);
  $('turbSub').textContent = `sensor ${fmt(r.turb_v, 2)} V`;
  $('vol').textContent = fmt(r.vol_ml, 0);
  $('volSub').textContent = r.drain ? `draining ${fmt(r.flow, 2)} L/min` : r.fill ? 'refilling' : 'pump idle';

  if (r.ml) showModel({ prediction: r.ml, where: 'decision tree on ESP32', epoch: r.epoch });

  setActuator('aDrain', r.drain);
  setActuator('aFill', r.fill);
  setActuator('aBuzzer', r.buzzer);
  const st = $('aState');
  st.classList.toggle('on', r.state && r.state !== 'idle' && r.state !== 'fault');
  st.classList.toggle('fault', r.state === 'fault');
  st.querySelector('b').textContent = r.state || '--';
  $('fault').textContent = r.fault ? `Fault: ${r.fault}. Pumps are locked until you reset.` : '';
  $('fault').classList.toggle('show', !!r.fault);

  const tag = $('modeTag');
  tag.textContent = r.state === 'fault' ? 'Fault' : r.demo ? 'Demo' : r.auto ? 'Auto' : 'Manual';
  tag.className = 'tag' + (r.state === 'fault' ? ' bad' : r.auto ? ' accent' : '');
  if (document.activeElement !== $('swAuto')) $('swAuto').checked = !!r.auto;
  if (document.activeElement !== $('swDemo')) $('swDemo').checked = !!r.demo;
}

function showModel(p) {
  const tile = $('modelTile');
  tile.classList.remove('clear', 'slightly_turbid', 'dirty');
  tile.classList.add(p.prediction);
  $('ml').textContent = LABEL_NAMES[p.prediction] || p.prediction || '--';
  const conf = p.confidence !== undefined && p.confidence !== null ? ` · ${(p.confidence * 100).toFixed(0)}%` : '';
  $('mlSub').textContent = `${p.where || 'model on laptop'}${conf}`;
}

// "last reading 4 s ago"
setInterval(() => {
  if (!lastAt) return;
  const s = Math.round((Date.now() - lastAt) / 1000);
  $('tLast').textContent = s < 60 ? `Last reading ${s}s ago` : `Last reading ${Math.round(s / 60)} min ago`;
}, 1000);

// ---------- Event log ----------
function addLog(e, top = true) {
  const body = $('log');
  if (body.querySelector('.empty')) body.innerHTML = '';
  const tr = document.createElement('tr');
  const detail = [e.name, e.value, e.detail].filter((x) => x !== null && x !== undefined && x !== '').join(' · ');
  tr.innerHTML = `<td class="time"></td><td class="type"><span></span></td><td></td>`;
  tr.children[0].textContent = clock(e.epoch);
  tr.children[1].firstChild.textContent = e.type;
  tr.children[1].firstChild.className = 't-' + e.type;
  tr.children[2].textContent = detail;
  top ? body.prepend(tr) : body.append(tr);
  while (body.children.length > 200) body.lastChild.remove();
  if (e.type === 'state' && String(e.detail || '').startsWith('change done')) setLastChange(e);
}
function setLastChange(e) {
  if (lastChange && lastChange.epoch >= e.epoch) return;
  lastChange = e;
  $('kvChange').textContent = `${String(e.detail).replace('change done ', '')} at ${clock(e.epoch)}`;
}

// ---------- Dataset ----------
async function loadStats() {
  const s = await api('/api/stats');
  const n = s.device || 0;
  $('nrec').textContent = n.toLocaleString();
  $('progress').style.width = Math.min(100, (n / TARGET_ROWS) * 100) + '%';
  $('progressText').textContent = n >= TARGET_ROWS ? 'Target of 1,000 records reached' : `${(TARGET_ROWS - n).toLocaleString()} more to reach 1,000`;
  if (s.sim) $('progressText').textContent += ` · ${s.sim.toLocaleString()} simulator rows excluded`;
  $('since').textContent = s.first ? 'since ' + new Date(s.first * 1000).toLocaleDateString() : '';
  $('labelCounts').textContent = s.labels.length ? s.labels.map((l) => `${LABEL_NAMES[l.label] || l.label}: ${l.n}`).join('   ') : '';
}

// ---------- Commands ----------
let fbTimer;
function feedback(text, kind = '') {
  const el = $('feedback');
  el.textContent = text; el.className = 'feedback ' + kind;
  clearTimeout(fbTimer); fbTimer = setTimeout(() => { el.textContent = ''; el.className = 'feedback'; }, 5000);
}
async function send(body, okText) {
  try { await api('/api/cmd', { method: 'POST', body: JSON.stringify(body) }); feedback(okText, 'ok'); return true; }
  catch (e) { if (e.message !== 'signed out') feedback(`Could not send command: ${e.message}`, 'error'); return false; }
}
document.querySelectorAll('[data-change]').forEach((b) => b.addEventListener('click', () =>
  send({ cmd: 'change', pct: Number(b.dataset.change) }, `Water change ${b.dataset.change}% requested`)));
document.querySelectorAll('[data-test]').forEach((b) => b.addEventListener('click', () =>
  send({ cmd: b.dataset.test, sec: 3 }, `${b.dataset.test === 'drain' ? 'Drain' : 'Fill'} pump test started`)));
document.querySelectorAll('[data-cmd]').forEach((b) => b.addEventListener('click', () =>
  send({ cmd: b.dataset.cmd }, { stop: 'Stop sent', reset: 'Reset sent', beep: 'Beep sent' }[b.dataset.cmd])));
for (const [id, cmd, name] of [['swAuto', 'auto', 'Automatic water change'], ['swDemo', 'demo', 'Demo timing']]) {
  $(id).addEventListener('change', async (ev) => {
    const on = ev.target.checked;
    if (!(await send({ cmd, on }, `${name} ${on ? 'on' : 'off'}`))) ev.target.checked = !on;
  });
}

document.querySelectorAll('#labels input').forEach((i) => i.addEventListener('change', async () => {
  try { await api('/api/label', { method: 'POST', body: JSON.stringify({ label: i.value }) }); feedback(i.value ? `Labelling new readings as "${LABEL_NAMES[i.value]}"` : 'Labelling turned off', 'ok'); }
  catch (e) { feedback(`Could not set label: ${e.message}`, 'error'); }
}));
function showLabel(label) {
  const input = document.querySelector(`#labels input[value="${label || ''}"]`);
  if (input) input.checked = true;
}

document.querySelectorAll('#range button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('#range button').forEach((x) => x.classList.toggle('active', x === b));
  rangeMin = Number(b.dataset.min);
  loadHistory();
}));

$('logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
  location.href = '/login';
});

// ---------- Live stream ----------
function health(h) {
  $('dMqtt').className = 'dot ' + (h.mqtt ? 'on' : 'off');
  $('tMqtt').textContent = h.mqtt ? 'MQTT connected' : 'MQTT down';
  $('dDev').className = 'dot ' + (h.device === 'online' ? 'on' : 'off');
  $('tDev').textContent = h.device === 'online' ? 'ESP32 online' : 'ESP32 offline';
  showLabel(h.label);
}
const es = new EventSource('/api/stream');
es.addEventListener('reading', (m) => {
  const r = JSON.parse(m.data);
  showReading(r); addRow(r); pushSpark(r);
  Object.values(charts).forEach((c) => c.update('none')); drawSparks();
});
es.addEventListener('event', (m) => addLog(JSON.parse(m.data)));
es.addEventListener('ml', (m) => { const p = JSON.parse(m.data); showModel({ ...p, where: p.model ? `${p.model} on laptop` : 'model on laptop' }); });
es.addEventListener('health', (m) => health(JSON.parse(m.data)));

(async () => {
  const session = await api('/api/session');
  $('logout').hidden = !session.auth;
  const l = await api('/api/latest');
  if (l.reading) showReading(l.reading);
  if (l.ml) showModel({ ...l.ml, where: l.ml.model ? `${l.ml.model} on laptop` : 'model on laptop' });
  health(l.health);
  const ev = await api('/api/events?limit=100');
  ev.forEach((e) => addLog(e, false));
  $('logCount').textContent = ev.length ? `latest ${ev.length}` : '';
  await Promise.all([loadHistory(), loadStats()]);
  setInterval(loadStats, 15000);
})().catch((e) => { if (e.message !== 'signed out') feedback(`Could not load data: ${e.message}`, 'error'); });
