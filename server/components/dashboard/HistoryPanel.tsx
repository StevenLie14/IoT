'use client';

import { useEffect, useRef, useState } from 'react';
import Chart from 'chart.js/auto';
import { SignedOutError, api } from '@/lib/client/api';
import { cssVar, formatTime } from '@/lib/client/format';
import type { Reading } from '@/lib/client/types';

type ChartName = 'score' | 'turbidity' | 'temperature' | 'pumps';

const RANGES = [
  { minutes: 10, label: '10m' },
  { minutes: 30, label: '30m' },
  { minutes: 120, label: '2h' },
  { minutes: 720, label: '12h' },
  { minutes: 1440, label: '24h' },
  { minutes: 10080, label: '7d' },
];

const MAX_POINTS = 1500;

function valuesFor(name: ChartName, row: Reading): (number | null)[] {
  if (name === 'score') return [row.score, row.tds];
  if (name === 'turbidity') return [row.turb, row.turb_v];
  if (name === 'temperature') return [row.t_tank];
  return [row.drain, row.fill];
}

function createCharts(canvases: Record<ChartName, HTMLCanvasElement | null>) {
  const colors = {
    ink: cssVar('--ink'),
    ink2: cssVar('--ink-2'),
    ink3: cssVar('--ink-3'),
    grid: cssVar('--line-2'),
    accent: cssVar('--accent'),
    ok: cssVar('--ok'),
    warn: cssVar('--warn'),
    bad: cssVar('--bad'),
  };

  Chart.defaults.font.family = cssVar('--sans');
  Chart.defaults.font.size = 11;
  Chart.defaults.color = colors.ink3;

  function lineChart(canvas: HTMLCanvasElement, datasets: object[], scales: Record<string, object> = {}) {
    return new Chart(canvas, {
      type: 'line',
      data: {
        labels: [],
        datasets: datasets.map((set) => ({ data: [], borderWidth: 1.6, pointRadius: 0, tension: 0.25, ...set })),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: { backgroundColor: colors.ink, padding: 8, cornerRadius: 4, boxPadding: 4 },
        },
        scales: {
          x: { grid: { display: false }, border: { color: colors.grid }, ticks: { maxTicksLimit: 6, maxRotation: 0, autoSkipPadding: 24 } },
          y: { grid: { color: colors.grid }, border: { display: false }, ticks: { maxTicksLimit: 5 } },
          ...scales,
        },
      },
    });
  }

  const percentAxis = { position: 'right', min: 0, max: 100, grid: { display: false }, border: { display: false } };
  const charts: Partial<Record<ChartName, Chart>> = {};

  if (canvases.score) {
    charts.score = lineChart(canvases.score, [
      { label: 'Score', borderColor: colors.ok, yAxisID: 'percent' },
      { label: 'TDS (ppm)', borderColor: colors.ink2, yAxisID: 'y' },
    ], { percent: percentAxis });
  }
  if (canvases.turbidity) {
    charts.turbidity = lineChart(canvases.turbidity, [
      { label: 'Index', borderColor: colors.warn, yAxisID: 'percent' },
      { label: 'Sensor (V)', borderColor: colors.ink3, yAxisID: 'y', borderDash: [3, 3] },
    ], { percent: percentAxis });
  }
  if (canvases.temperature) {
    charts.temperature = lineChart(canvases.temperature, [
      { label: 'Tank (°C)', borderColor: colors.bad },
    ]);
  }
  if (canvases.pumps) {
    charts.pumps = lineChart(canvases.pumps, [
      { label: 'Drain', borderColor: colors.bad, backgroundColor: `${colors.bad}22`, fill: true, stepped: true, tension: 0 },
      { label: 'Fill', borderColor: colors.accent, backgroundColor: `${colors.accent}22`, fill: true, stepped: true, tension: 0 },
    ], {
      y: {
        min: 0,
        max: 1.2,
        grid: { color: colors.grid },
        border: { display: false },
        ticks: { stepSize: 1, callback: (value: number | string) => (value === 1 ? 'on' : value === 0 ? 'off' : '') },
      },
    });
  }

  return charts;
}

export default function HistoryPanel({ latest }: { latest: Reading | null }) {
  const [minutes, setMinutes] = useState(30);
  const [error, setError] = useState('');
  const canvases = useRef<Record<ChartName, HTMLCanvasElement | null>>({ score: null, turbidity: null, temperature: null, pumps: null });
  const charts = useRef<Partial<Record<ChartName, Chart>>>({});
  const lastAddedId = useRef<number | null>(null);

  useEffect(() => {
    const created = createCharts(canvases.current);
    charts.current = created;
    return () => {
      Object.values(created).forEach((chart) => chart?.destroy());
      charts.current = {};
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    api<Reading[]>(`/api/history?minutes=${minutes}`)
      .then((rows) => {
        if (cancelled) return;
        setError('');
        lastAddedId.current = rows.length ? rows[rows.length - 1].id : null;
        for (const [name, chart] of Object.entries(charts.current) as [ChartName, Chart][]) {
          chart.data.labels = rows.map((row) => formatTime(row.epoch));
          chart.data.datasets.forEach((dataset, index) => {
            dataset.data = rows.map((row) => valuesFor(name, row)[index]);
          });
          chart.update();
        }
      })
      .catch((err) => {
        if (!cancelled && !(err instanceof SignedOutError)) setError(`Could not load history: ${err.message}`);
      });

    return () => {
      cancelled = true;
    };
  }, [minutes]);

  useEffect(() => {
    if (!latest || latest.id === lastAddedId.current) return;
    lastAddedId.current = latest.id;

    for (const [name, chart] of Object.entries(charts.current) as [ChartName, Chart][]) {
      chart.data.labels?.push(formatTime(latest.epoch));
      chart.data.datasets.forEach((dataset, index) => dataset.data.push(valuesFor(name, latest)[index]));
      if ((chart.data.labels?.length ?? 0) > MAX_POINTS) {
        chart.data.labels?.shift();
        chart.data.datasets.forEach((dataset) => dataset.data.shift());
      }
      chart.update('none');
    }
  }, [latest]);

  function chartBox(name: ChartName) {
    return (
      <div className="box">
        <canvas ref={(element) => { canvases.current[name] = element; }} />
      </div>
    );
  }

  return (
    <section className="panel">
      <header>
        <h2>History</h2>
        <div className="segmented" id="range" role="group" aria-label="Time range">
          {RANGES.map((range) => (
            <button key={range.minutes} className={minutes === range.minutes ? 'active' : ''}
              onClick={() => setMinutes(range.minutes)}>
              {range.label}
            </button>
          ))}
        </div>
      </header>

      {error && <p className="panel-error">{error}</p>}

      <div className="charts">
        <div className="chart">
          <h3>
            Health score and TDS
            <span className="key"><i style={{ background: 'var(--ok)' }} />score</span>
            <span className="key"><i style={{ background: 'var(--ink-2)' }} />ppm</span>
          </h3>
          {chartBox('score')}
        </div>
        <div className="chart">
          <h3>
            Turbidity
            <span className="key"><i style={{ background: 'var(--warn)' }} />index</span>
            <span className="key"><i style={{ background: 'var(--ink-3)' }} />volts</span>
          </h3>
          {chartBox('turbidity')}
        </div>
        <div className="chart">
          <h3>
            Temperature
            <span className="key"><i style={{ background: 'var(--bad)' }} />tank</span>
          </h3>
          {chartBox('temperature')}
        </div>
        <div className="chart">
          <h3>
            Pumps
            <span className="key"><i style={{ background: 'var(--bad)' }} />drain</span>
            <span className="key"><i style={{ background: 'var(--accent)' }} />fill</span>
          </h3>
          {chartBox('pumps')}
        </div>
      </div>
    </section>
  );
}
