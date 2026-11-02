'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Chart from 'chart.js/auto';

type Row = Record<string, any>;
type Health = { mqtt: boolean; device: string; dataFresh: boolean; label: string };
type Ml = { prediction: string; confidence?: number | null; where: string };
type Stats = { device?: number; sim?: number; first?: number | null; labels: { label: string; n: number }[] };
type Ev = { epoch: number; type: string; name?: string | null; value?: number | null; detail?: string | null };

const LABEL_NAMES: Record<string, string> = { clear: 'Clear', slightly_turbid: 'Slightly turbid', dirty: 'Dirty' };
const TARGET_ROWS = 1000;
const RANGES = [[10, '10m'], [30, '30m'], [120, '2h'], [720, '12h'], [1440, '24h'], [10080, '7d']] as const;

const fmt = (v: unknown, d = 1) => (v === null || v === undefined || Number.isNaN(Number(v)) ? '--' : Number(v).toFixed(d));
const clock = (e: number) => new Date(e * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const scoreClass = (s: number) => (s >= 80 ? 'ok' : s >= 60 ? 'warn' : 'bad');
const scoreWord = (s: number) => (s >= 80 ? 'Good' : s >= 60 ? 'Fair' : 'Poor, change due');
const cssVar = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

async function api<T = any>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin', ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  if (res.status === 401) { window.location.href = '/login'; throw new Error('signed out'); }
  const body = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) throw new Error(body?.error || res.statusText);
  return body as T;
}

// ---------- Sparkline ----------
function Sparkline({ values }: { values: (number | null)[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const draw = () => {
      const cv = ref.current; if (!cv) return;
      const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
      if (!w) return;
      cv.width = w * dpr; cv.height = h * dpr;
      const ctx = cv.getContext('2d')!; ctx.scale(dpr, dpr); ctx.clearRect(0, 0, w, h);
      const pts = values.filter((v): v is number => v !== null && v !== undefined);
      if (pts.length < 2) return;
      let min = Math.min(...pts), max = Math.max(...pts);
      if (max - min < 1e-6) { min -= 1; max += 1; }
      ctx.strokeStyle = cssVar('--ink-3'); ctx.lineWidth = 1.2; ctx.beginPath();
      pts.forEach((v, i) => {
        const x = (i / (pts.length - 1)) * (w - 2) + 1, y = h - 2 - ((v - min) / (max - min)) * (h - 4);
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      });
      ctx.stroke();
    };
    draw();
    window.addEventListener('resize', draw);
    return () => window.removeEventListener('resize', draw);
  }, [values]);
  return <canvas ref={ref} aria-hidden="true" />;
}

// ---------- History charts ----------
type ChartKey = 'score' | 'turb' | 'temp' | 'pump';
const rowValues = (r: Row): Record<ChartKey, unknown[]> => ({ score: [r.score, r.tds], turb: [r.turb, r.turb_v], temp: [r.t_tank, r.t_res], pump: [r.drain, r.fill] });

function useCharts() {
  const canvases = useRef<Record<ChartKey, HTMLCanvasElement | null>>({ score: null, turb: null, temp: null, pump: null });
  const charts = useRef<Partial<Record<ChartKey, Chart>>>({});

  useEffect(() => {
    const C = { ink: cssVar('--ink'), ink2: cssVar('--ink-2'), ink3: cssVar('--ink-3'), line: cssVar('--line-2'),
      accent: cssVar('--accent'), ok: cssVar('--ok'), warn: cssVar('--warn'), bad: cssVar('--bad') };
    Chart.defaults.font.family = cssVar('--sans');
    Chart.defaults.font.size = 11;
    Chart.defaults.color = C.ink3;
    const make = (key: ChartKey, sets: any[], opts: { y?: any; y1?: any } = {}) => {
      const cv = canvases.current[key]; if (!cv) return;
      charts.current[key] = new Chart(cv, {
        type: 'line',
        data: { labels: [], datasets: sets.map((s) => ({ data: [], borderWidth: 1.6, pointRadius: 0, tension: 0.25, ...s })) },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false, normalized: true,
          interaction: { mode: 'index', intersect: false },
          plugins: { legend: { display: false }, tooltip: { backgroundColor: C.ink, padding: 8, cornerRadius: 4, boxPadding: 4 } },
          scales: {
            x: { grid: { display: false }, border: { color: C.line }, ticks: { maxTicksLimit: 6, maxRotation: 0, autoSkipPadding: 24 } },
            y: { grid: { color: C.line }, border: { display: false }, ticks: { maxTicksLimit: 5 }, ...(opts.y || {}) },
            ...(opts.y1 ? { y1: { position: 'right', grid: { display: false }, border: { display: false }, ticks: { maxTicksLimit: 5 }, ...opts.y1 } } : {}),
          },
        },
      });
    };
    make('score', [{ label: 'Score', borderColor: C.ok, yAxisID: 'y1' }, { label: 'TDS (ppm)', borderColor: C.ink2, yAxisID: 'y' }], { y1: { min: 0, max: 100 } });
    make('turb', [{ label: 'Index', borderColor: C.warn, yAxisID: 'y1' }, { label: 'Sensor (V)', borderColor: C.ink3, yAxisID: 'y', borderDash: [3, 3] }], { y1: { min: 0, max: 100 } });
    make('temp', [{ label: 'Tank (°C)', borderColor: C.bad }, { label: 'Reservoir (°C)', borderColor: C.accent }]);
    make('pump', [
      { label: 'Drain', borderColor: C.bad, backgroundColor: C.bad + '22', fill: true, stepped: true, tension: 0 },
      { label: 'Fill', borderColor: C.accent, backgroundColor: C.accent + '22', fill: true, stepped: true, tension: 0 },
    ], { y: { min: 0, max: 1.2, ticks: { stepSize: 1, callback: (v: number) => (v === 1 ? 'on' : v === 0 ? 'off' : '') } } });
    const created = charts.current;
    return () => { Object.values(created).forEach((c) => c?.destroy()); charts.current = {}; };
  }, []);

  const setRows = useCallback((rows: Row[]) => {
    for (const [k, c] of Object.entries(charts.current) as [ChartKey, Chart][]) {
      c.data.labels = rows.map((r) => clock(r.epoch));
      c.data.datasets.forEach((d, i) => { d.data = rows.map((r) => rowValues(r)[k][i] as number); });
      c.update();
    }
  }, []);
  const addRow = useCallback((r: Row) => {
    for (const [k, c] of Object.entries(charts.current) as [ChartKey, Chart][]) {
      c.data.labels!.push(clock(r.epoch));
      c.data.datasets.forEach((d, i) => d.data.push(rowValues(r)[k][i] as number));
      if (c.data.labels!.length > 1500) { c.data.labels!.shift(); c.data.datasets.forEach((d) => d.data.shift()); }
      c.update('none');
    }
  }, []);
  return { canvases, setRows, addRow };
}

// ---------- Dashboard ----------
export default function Dashboard({ authEnabled }: { authEnabled: boolean }) {
  const [r, setR] = useState<Row | null>(null);
  const [lastAt, setLastAt] = useState(0);
  const [, tick] = useState(0);
  const [health, setHealth] = useState<Health | null>(null);
  const [ml, setMl] = useState<Ml | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [events, setEvents] = useState<Ev[]>([]);
  const [lastChange, setLastChange] = useState<Ev | null>(null);
  const [spark, setSpark] = useState<Record<'temp' | 'tds' | 'turb' | 'vol', (number | null)[]>>({ temp: [], tds: [], turb: [], vol: [] });
  const [range, setRange] = useState(30);
  const [feedback, setFeedback] = useState<{ text: string; kind: string } | null>(null);
  const fbTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const { canvases, setRows, addRow } = useCharts();

  const say = useCallback((text: string, kind = '') => {
    setFeedback({ text, kind });
    clearTimeout(fbTimer.current);
    fbTimer.current = setTimeout(() => setFeedback(null), 5000);
  }, []);

  const pushSpark = useCallback((rows: Row[], replace = false) => {
    setSpark((s) => {
      const next = replace ? { temp: [], tds: [], turb: [], vol: [] } as typeof s : { ...s };
      const keep = (a: (number | null)[], v: number | null) => [...a, v].slice(-60);
      for (const row of rows) {
        next.temp = keep(next.temp, row.t_tank); next.tds = keep(next.tds, row.tds);
        next.turb = keep(next.turb, row.turb); next.vol = keep(next.vol, row.vol_ml);
      }
      return next;
    });
  }, []);

  const noteEvent = useCallback((e: Ev) => {
    if (e.type === 'state' && String(e.detail || '').startsWith('change done'))
      setLastChange((p) => (p && p.epoch >= e.epoch ? p : e));
  }, []);

  const loadStats = useCallback(async () => setStats(await api<Stats>('/api/stats')), []);

  // History for the selected range
  useEffect(() => {
    api<Row[]>('/api/history?minutes=' + range).then((rows) => { setRows(rows); pushSpark(rows.slice(-60), true); })
      .catch((e) => e.message !== 'signed out' && say(`Could not load history: ${e.message}`, 'error'));
  }, [range, setRows, pushSpark, say]);

  // Initial data, live stream, timers
  useEffect(() => {
    let closed = false;
    (async () => {
      const l = await api('/api/latest');
      if (closed) return;
      if (l.reading) { setR(l.reading); setLastAt(Date.now()); }
      if (l.ml) setMl({ ...l.ml, where: l.ml.model ? `${l.ml.model} on laptop` : 'model on laptop' });
      setHealth(l.health);
      const ev = await api<Ev[]>('/api/events?limit=100');
      if (closed) return;
      setEvents(ev); ev.forEach(noteEvent);
      await loadStats();
    })().catch((e) => e.message !== 'signed out' && say(`Could not load data: ${e.message}`, 'error'));

    const es = new EventSource('/api/stream');
    es.addEventListener('reading', (m) => {
      const row = JSON.parse((m as MessageEvent).data);
      setR(row); setLastAt(Date.now()); addRow(row); pushSpark([row]);
    });
    es.addEventListener('event', (m) => {
      const e = JSON.parse((m as MessageEvent).data);
      setEvents((list) => [e, ...list].slice(0, 200)); noteEvent(e);
    });
    es.addEventListener('ml', (m) => {
      const p = JSON.parse((m as MessageEvent).data);
      setMl({ ...p, where: p.model ? `${p.model} on laptop` : 'model on laptop' });
    });
    es.addEventListener('health', (m) => setHealth(JSON.parse((m as MessageEvent).data)));
    const t1 = setInterval(() => tick((n) => n + 1), 1000);
    const t2 = setInterval(() => loadStats().catch(() => {}), 15000);
    return () => { closed = true; es.close(); clearInterval(t1); clearInterval(t2); };
  }, [addRow, pushSpark, noteEvent, loadStats, say]);

  // Prediction made on the ESP32 arrives inside the reading
  const model: Ml | null = r?.ml ? { prediction: r.ml, where: 'decision tree on ESP32' } : ml;

  async function send(body: object, okText: string) {
    try { await api('/api/cmd', { method: 'POST', body: JSON.stringify(body) }); say(okText, 'ok'); return true; }
    catch (e) { if ((e as Error).message !== 'signed out') say(`Could not send command: ${(e as Error).message}`, 'error'); return false; }
  }
  async function setLabel(label: string) {
    setHealth((h) => (h ? { ...h, label } : h));
    try {
      await api('/api/label', { method: 'POST', body: JSON.stringify({ label }) });
      say(label ? `Labelling new readings as "${LABEL_NAMES[label]}"` : 'Labelling turned off', 'ok');
    } catch (e) { say(`Could not set label: ${(e as Error).message}`, 'error'); }
  }
  async function logout() {
    await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
    window.location.href = '/login';
  }

  const s = r?.score as number | null | undefined;
  const ago = lastAt ? Math.round((Date.now() - lastAt) / 1000) : null;
  const deviceRows = stats?.device || 0;
  const mode = r ? (r.state === 'fault' ? 'Fault' : r.demo ? 'Demo' : r.auto ? 'Auto' : 'Manual') : '--';

  return (
    <>
      <header className="topbar">
        <div className="brand">AquaGuard <small>Tank 01</small></div>
        <div className="conn" aria-label="Connection status">
          <span><i className={'dot ' + (health ? (health.device === 'online' ? 'on' : 'off') : '')} />{health?.device === 'online' ? 'ESP32 online' : 'ESP32 offline'}</span>
          <span><i className={'dot ' + (health ? (health.mqtt ? 'on' : 'off') : '')} />{health?.mqtt ? 'MQTT connected' : 'MQTT down'}</span>
          <span className="hide-sm muted">{ago === null ? 'No readings yet' : ago < 60 ? `Last reading ${ago}s ago` : `Last reading ${Math.round(ago / 60)} min ago`}</span>
        </div>
        <div className="right">
          <span className={'tag' + (r?.state === 'fault' ? ' bad' : r?.auto ? ' accent' : '')}>{mode}</span>
          {authEnabled && <button className="linkbtn" onClick={logout}>Sign out</button>}
        </div>
      </header>

      <main className="wrap">
        <section className="overview">
          <div className={'panel score ' + (s !== null && s !== undefined ? scoreClass(s) : '')}>
            <header><h2>Water health</h2><span className="muted num">{r?.state || '--'}</span></header>
            <div className="body">
              <div className="score-row">
                <span className="score-value num">{s ?? '--'}</span>
                <span className="score-word">{s !== null && s !== undefined ? scoreWord(s) : 'Waiting for data'}</span>
              </div>
              <div className="meter" aria-hidden="true"><i style={{ width: `${Math.max(0, Math.min(100, s ?? 0))}%` }} /><b title="Water change threshold" /></div>
              <div className="meter-scale"><span style={{ left: 0 }}>0</span><span style={{ left: '60%' }}>60</span><span style={{ right: 0 }}>100</span></div>
              <dl className="kv">
                <dt>Automatic change</dt><dd>{r ? (r.auto ? (r.demo ? 'On, demo timing' : 'On') : 'Off') : '--'}</dd>
                <dt>Last water change</dt><dd>{lastChange ? `${String(lastChange.detail).replace('change done ', '')} at ${clock(lastChange.epoch)}` : '--'}</dd>
                <dt>Source</dt><dd>{r ? (r.source === 'sim' ? 'Simulator' : 'ESP32') : '--'}</dd>
              </dl>
            </div>
          </div>

          <div className="panel readings">
            <div className="reading">
              <span className="label">Temperature</span>
              <div className="value"><span className="num">{fmt(r?.t_tank)}</span><span className="unit">°C</span></div>
              <span className="sub">{r?.t_res === null || r?.t_res === undefined ? 'reservoir not fitted' : `reservoir ${fmt(r.t_res)} °C`}</span>
              <Sparkline values={spark.temp} />
            </div>
            <div className="reading">
              <span className="label">Dissolved solids</span>
              <div className="value"><span className="num">{fmt(r?.tds, 0)}</span><span className="unit">ppm</span></div>
              <span className="sub">probe {fmt(r?.tds_v, 3)} V</span>
              <Sparkline values={spark.tds} />
            </div>
            <div className="reading">
              <span className="label">Turbidity</span>
              <div className="value"><span className="num">{fmt(r?.turb, 0)}</span><span className="unit">/ 100</span></div>
              <span className="sub">sensor {fmt(r?.turb_v, 2)} V</span>
              <Sparkline values={spark.turb} />
            </div>
            <div className="reading">
              <span className="label">Drained this change</span>
              <div className="value"><span className="num">{fmt(r?.vol_ml, 0)}</span><span className="unit">ml</span></div>
              <span className="sub">{r?.drain ? `draining ${fmt(r.flow, 2)} L/min` : r?.fill ? 'refilling' : 'pump idle'}</span>
              <Sparkline values={spark.vol} />
            </div>
            <div className={'reading model ' + (model?.prediction || '')}>
              <span className="label">Condition (model)</span>
              <div className="value"><span className="word">{model ? LABEL_NAMES[model.prediction] || model.prediction : '--'}</span></div>
              <span className="sub">{model ? `${model.where}${model.confidence !== undefined && model.confidence !== null ? ` · ${(model.confidence * 100).toFixed(0)}%` : ''}` : 'no model loaded'}</span>
            </div>
          </div>
        </section>

        <section className="split">
          <div className="panel">
            <header><h2>Control</h2></header>
            <div className="body">
              <div className="actuators">
                {([['Drain pump', r?.drain], ['Fill pump', r?.fill], ['Buzzer', r?.buzzer]] as const).map(([name, on]) => (
                  <div key={name} className={'actuator' + (on ? ' on' : '')}><span>{name}</span><strong><i className="dot" /><b>{r ? (on ? 'On' : 'Off') : '--'}</b></strong></div>
                ))}
                <div className={'actuator' + (r?.state === 'fault' ? ' fault' : r?.state && r.state !== 'idle' ? ' on' : '')}><span>State</span><strong><b>{r?.state || '--'}</b></strong></div>
              </div>
              <div className={'fault-banner' + (r?.fault ? ' show' : '')}>{r?.fault ? `Fault: ${r.fault}. Pumps are locked until you reset.` : ''}</div>

              <div className="control-group">
                <span className="title">Water change</span>
                <div className="row">
                  <div className="segmented" role="group" aria-label="Water change percentage">
                    {[10, 20, 30].map((p) => <button key={p} onClick={() => send({ cmd: 'change', pct: p }, `Water change ${p}% requested`)}>{p}%</button>)}
                  </div>
                  <button className="btn danger" onClick={() => send({ cmd: 'stop' }, 'Stop sent')}>Stop</button>
                  <button className="btn quiet" onClick={() => send({ cmd: 'reset' }, 'Reset sent')}>Reset fault</button>
                </div>
              </div>

              <div className="control-group">
                <span className="title">Mode</span>
                <div className="row" style={{ gap: 24 }}>
                  <label className="switch"><input type="checkbox" checked={!!r?.auto} onChange={(e) => send({ cmd: 'auto', on: e.target.checked }, `Automatic water change ${e.target.checked ? 'on' : 'off'}`)} /><i />Automatic water change</label>
                  <label className="switch"><input type="checkbox" checked={!!r?.demo} onChange={(e) => send({ cmd: 'demo', on: e.target.checked }, `Demo timing ${e.target.checked ? 'on' : 'off'}`)} /><i />Demo timing</label>
                </div>
              </div>

              <div className="control-group">
                <span className="title">Test</span>
                <div className="row">
                  <button className="btn" onClick={() => send({ cmd: 'drain', sec: 3 }, 'Drain pump test started')}>Run drain 3 s</button>
                  <button className="btn" onClick={() => send({ cmd: 'fill', sec: 3 }, 'Fill pump test started')}>Run fill 3 s</button>
                  <button className="btn quiet" onClick={() => send({ cmd: 'beep' }, 'Beep sent')}>Beep</button>
                </div>
              </div>
              <div className={'feedback ' + (feedback?.kind || '')} role="status" aria-live="polite">{feedback?.text}</div>
            </div>
          </div>

          <div className="panel dataset">
            <header><h2>Dataset</h2><span className="muted">{stats?.first ? 'since ' + new Date(stats.first * 1000).toLocaleDateString() : ''}</span></header>
            <div className="body">
              <div className="count"><span className="num">{stats ? deviceRows.toLocaleString() : '--'}</span><span className="muted">device records</span></div>
              <div className="progress" aria-hidden="true"><i style={{ width: `${Math.min(100, (deviceRows / TARGET_ROWS) * 100)}%` }} /></div>
              <span className="muted" style={{ fontSize: 12 }}>
                {deviceRows >= TARGET_ROWS ? 'Target of 1,000 records reached' : `${(TARGET_ROWS - deviceRows).toLocaleString()} more to reach 1,000`}
                {stats?.sim ? ` · ${stats.sim.toLocaleString()} simulator rows excluded` : ''}
              </span>

              <div className="control-group">
                <span className="title">Label new readings</span>
                <div className="segmented" id="labels" role="radiogroup" aria-label="Condition label">
                  {['', 'clear', 'slightly_turbid', 'dirty'].map((v) => (
                    <label key={v || 'none'}>
                      <input type="radio" name="label" value={v} checked={(health?.label || '') === v} onChange={() => setLabel(v)} />
                      <span>{v ? LABEL_NAMES[v] : 'None'}</span>
                    </label>
                  ))}
                </div>
                <p className="help">Match the label to the water in the tank while recording. The classifier is trained on these rows.</p>
                {!!stats?.labels.length && <p className="help num">{stats.labels.map((l) => `${LABEL_NAMES[l.label] || l.label}: ${l.n}`).join('   ')}</p>}
              </div>

              <div className="downloads">
                <a href="/api/export.csv?source=device">Device CSV</a>
                <a href="/api/export.csv">All rows</a>
                <a href="/api/events.csv">Event log CSV</a>
              </div>
            </div>
          </div>
        </section>

        <section className="panel">
          <header>
            <h2>History</h2>
            <div className="segmented" id="range" role="group" aria-label="Time range">
              {RANGES.map(([m, label]) => <button key={m} className={range === m ? 'active' : ''} onClick={() => setRange(m)}>{label}</button>)}
            </div>
          </header>
          <div className="charts">
            <div className="chart"><h3>Health score and TDS <span className="key"><i style={{ background: 'var(--ok)' }} />score</span><span className="key"><i style={{ background: 'var(--ink-2)' }} />ppm</span></h3><div className="box"><canvas ref={(el) => { canvases.current.score = el; }} /></div></div>
            <div className="chart"><h3>Turbidity <span className="key"><i style={{ background: 'var(--warn)' }} />index</span><span className="key"><i style={{ background: 'var(--ink-3)' }} />volts</span></h3><div className="box"><canvas ref={(el) => { canvases.current.turb = el; }} /></div></div>
            <div className="chart"><h3>Temperature <span className="key"><i style={{ background: 'var(--bad)' }} />tank</span><span className="key"><i style={{ background: 'var(--accent)' }} />reservoir</span></h3><div className="box"><canvas ref={(el) => { canvases.current.temp = el; }} /></div></div>
            <div className="chart"><h3>Pumps <span className="key"><i style={{ background: 'var(--bad)' }} />drain</span><span className="key"><i style={{ background: 'var(--accent)' }} />fill</span></h3><div className="box"><canvas ref={(el) => { canvases.current.pump = el; }} /></div></div>
          </div>
        </section>

        <section className="panel">
          <header><h2>Event log</h2><span className="muted">{events.length ? `latest ${events.length}` : ''}</span></header>
          <div className="log">
            <table><tbody>
              {events.length === 0 && <tr><td className="empty" colSpan={3}>No events yet.</td></tr>}
              {events.map((e, i) => (
                <tr key={`${e.epoch}-${i}`}>
                  <td className="time">{clock(e.epoch)}</td>
                  <td className="type"><span className={'t-' + e.type}>{e.type}</span></td>
                  <td>{[e.name, e.value, e.detail].filter((x) => x !== null && x !== undefined && x !== '').join(' · ')}</td>
                </tr>
              ))}
            </tbody></table>
          </div>
        </section>
      </main>
    </>
  );
}
