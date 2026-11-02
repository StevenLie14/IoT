// AquaGuard dashboard client
let last = null;
const $ = (id) => document.getElementById(id);
const fmt = (v, d = 1) => (v === null || v === undefined || Number.isNaN(v) ? '--' : Number(v).toFixed(d));
const time = (e) => new Date(e * 1000).toLocaleTimeString();

// ---------- Charts ----------
const base = (title, yLabel) => ({
  type: 'line', data: { labels: [], datasets: [] },
  options: { responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: 'index', intersect: false },
    plugins: { title: { display: true, text: title }, legend: { position: 'bottom', labels: { boxWidth: 12 } } },
    scales: { x: { ticks: { maxTicksLimit: 8 } }, y: { title: { display: !!yLabel, text: yLabel } } },
    elements: { point: { radius: 0 }, line: { borderWidth: 2, tension: 0.2 } } },
});
const ds = (label, color, extra = {}) => ({ label, data: [], borderColor: color, backgroundColor: color + '33', ...extra });

const cScore = new Chart($('cScore'), base('TDS and health score'));
cScore.data.datasets = [ds('TDS (ppm)', '#2563eb', { yAxisID: 'y' }), ds('Score', '#2e9e5b', { yAxisID: 'y1' })];
cScore.options.scales.y1 = { position: 'right', min: 0, max: 100, grid: { drawOnChartArea: false } };
const cTurb = new Chart($('cTurb'), base('Turbidity', 'volts / index'));
cTurb.data.datasets = [ds('Sensor voltage (V)', '#9333ea'), ds('Index (0-100)', '#e3a008', { yAxisID: 'y1' })];
cTurb.options.scales.y1 = { position: 'right', min: 0, max: 100, grid: { drawOnChartArea: false } };
const cTemp = new Chart($('cTemp'), base('Temperature', '°C'));
cTemp.data.datasets = [ds('Tank', '#d64545'), ds('Reservoir', '#0ea5e9')];
const cPump = new Chart($('cPump'), base('Pumps (1 = on)'));
cPump.data.datasets = [ds('Drain', '#d64545', { stepped: true, fill: true }), ds('Fill', '#2563eb', { stepped: true, fill: true })];
cPump.options.scales.y = { min: 0, max: 1.2, ticks: { stepSize: 1 } };
const charts = [cScore, cTurb, cTemp, cPump];

function pushRow(r, trim = true) {
  const lab = time(r.epoch);
  const vals = [[r.tds, r.score], [r.turb_v, r.turb], [r.t_tank, r.t_res], [r.drain, r.fill]];
  charts.forEach((c, i) => {
    c.data.labels.push(lab);
    c.data.datasets.forEach((d, j) => d.data.push(vals[i][j]));
    if (trim && c.data.labels.length > 1500) { c.data.labels.shift(); c.data.datasets.forEach((d) => d.data.shift()); }
  });
}

async function loadHistory() {
  const rows = await (await fetch('/api/history?minutes=' + $('range').value)).json();
  charts.forEach((c) => { c.data.labels = []; c.data.datasets.forEach((d) => (d.data = [])); });
  rows.forEach((r) => pushRow(r, false));
  charts.forEach((c) => c.update());
}

// ---------- Cards ----------
function showReading(r) {
  last = r;
  const s = r.score;
  $('score').textContent = s ?? '--';
  $('score').style.color = s >= 80 ? 'var(--good)' : s >= 60 ? 'var(--warn)' : 'var(--bad)';
  $('state').textContent = 'state: ' + (r.state || '--') + (r.source === 'sim' ? '  (SIMULATOR)' : '');
  $('temp').textContent = fmt(r.t_tank);
  $('tres').textContent = r.t_res === null || r.t_res === undefined ? 'reservoir: not fitted' : 'reservoir: ' + fmt(r.t_res) + ' °C';
  $('tds').textContent = fmt(r.tds, 0);
  $('tdsv').textContent = 'probe ' + fmt(r.tds_v, 3) + ' V';
  $('turb').textContent = fmt(r.turb, 0);
  $('turbv').textContent = 'sensor ' + fmt(r.turb_v, 2) + ' V';
  $('vol').textContent = fmt(r.vol_ml, 0);
  $('flow').textContent = 'flow ' + fmt(r.flow, 2) + ' L/min (estimate)';
  const pill = (name, on, cls = 'active') => `<span class="pill ${on ? cls : ''}">${name}: ${on ? 'ON' : 'off'}</span>`;
  $('act').innerHTML = pill('Drain pump', r.drain) + pill('Fill pump', r.fill) + pill('Buzzer', r.buzzer) +
    `<span class="pill ${r.state === 'fault' ? 'fault' : r.state !== 'idle' ? 'active' : ''}">State: ${r.state}</span>`;
  $('bAuto').textContent = 'Auto: ' + (r.auto ? 'ON' : 'off');
  $('bDemo').textContent = 'Demo: ' + (r.demo ? 'ON' : 'off');
  $('fault').textContent = r.fault ? 'Fault: ' + r.fault : '';
}

function addLog(e, top = true) {
  const div = document.createElement('div');
  div.innerHTML = `<span class="muted">${time(e.epoch)}</span> <b>${e.type}</b> ${e.name ?? ''} ${e.value ?? ''} <span class="muted">${e.detail ?? ''}</span>`;
  top ? $('log').prepend(div) : $('log').append(div);
  while ($('log').children.length > 200) $('log').lastChild.remove();
}

async function loadStats() {
  const s = await (await fetch('/api/stats')).json();
  $('nrec').textContent = s.n;
  $('nsplit').textContent = `device ${s.device || 0} · simulator ${s.sim || 0} · events ${s.events}` +
    (s.first ? ` · since ${new Date(s.first * 1000).toLocaleString()}` : '');
  $('labelcount').textContent = s.labels.length ? 'Labelled device rows: ' + s.labels.map((l) => `${l.label} ${l.n}`).join(', ') : '';
}

// ---------- Actions ----------
async function cmd(body) {
  const r = await fetch('/api/cmd', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) alert('Command failed: ' + (await r.json()).error);
}
async function setLabel(label) {
  await fetch('/api/label', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label }) });
}

// ---------- Live stream ----------
const es = new EventSource('/api/stream');
es.addEventListener('reading', (m) => { const r = JSON.parse(m.data); showReading(r); pushRow(r); charts.forEach((c) => c.update()); });
es.addEventListener('event', (m) => addLog(JSON.parse(m.data)));
function showMl(p) {
  $('ml').textContent = p.prediction ?? '--';
  $('mlsub').textContent = (p.confidence !== undefined && p.confidence !== null ? `confidence ${(p.confidence * 100).toFixed(0)}% · ` : '') + time(p.epoch);
}
es.addEventListener('ml', (m) => showMl(JSON.parse(m.data)));
es.addEventListener('health', (m) => {
  const h = JSON.parse(m.data);
  $('dMqtt').className = 'dot ' + (h.mqtt ? 'on' : 'off');
  $('dDev').className = 'dot ' + (h.device === 'online' ? 'on' : 'off');
  $('dData').className = 'dot ' + (h.dataFresh ? 'on' : 'off');
  if (document.activeElement !== $('label')) $('label').value = h.label || '';
});

(async () => {
  const l = await (await fetch('/api/latest')).json();
  if (l.reading) showReading(l.reading);
  if (l.ml) showMl(l.ml);
  (await (await fetch('/api/events?limit=50')).json()).forEach((e) => addLog(e, false));
  loadHistory(); loadStats();
  setInterval(loadStats, 10000);
})();
