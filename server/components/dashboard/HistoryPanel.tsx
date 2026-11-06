'use client';

import { useEffect, useRef, useState } from 'react';
import Chart from 'chart.js/auto';
import { SignedOutError, api } from '@/lib/client/api';
import { cssVariable, formatTime } from '@/lib/client/format';
import type { Reading } from '@/lib/client/types';

type ChartName = 'score' | 'turbidity' | 'temperature' | 'pumps' | 'prediction';

// Kelas model jadi angka 0 / 1 / 2 supaya bisa digambar di chart
const PREDICTION_LEVELS = ['clear', 'slightly_turbid', 'dirty'];
const PREDICTION_TICKS = ['clear', 'slightly turbid', 'dirty'];

function predictionLevel(modelClass: string | null | undefined) {
  const level = PREDICTION_LEVELS.indexOf(modelClass ?? '');
  return level < 0 ? null : level;
}

// Confidence 0-1 jadi persen
function confidencePercent(confidence: number | null | undefined) {
  return confidence === null || confidence === undefined ? null : Math.round(confidence * 100);
}

// Range waktu yg bisa dipilih di ui
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
  if (name === 'turbidity') return [row.turb];
  if (name === 'temperature') return [row.t_tank];
  if (name === 'prediction') return [predictionLevel(row.ml), confidencePercent(row.ml_conf)];
  return [row.drain, row.fill];
}

function createCharts(canvases: Record<ChartName, HTMLCanvasElement | null>) {
  const colors = {
    ink: cssVariable('--ink'),
    panel: cssVariable('--panel'),
    ink2: cssVariable('--ink-2'),
    ink3: cssVariable('--ink-3'),
    grid: cssVariable('--line-2'),
    accent: cssVariable('--accent'),
    ok: cssVariable('--ok'),
    warn: cssVariable('--warn'),
    bad: cssVariable('--bad'),
  };

  Chart.defaults.font.family = cssVariable('--sans');
  Chart.defaults.font.size = 11;
  Chart.defaults.color = colors.ink3;

  // Config line chart
  function lineChart(canvas: HTMLCanvasElement, datasets: object[], scales: Record<string, object> = {}) {
    return new Chart(canvas, {
      type: 'line',
      data: {
        labels: [],
        datasets: datasets.map((dataset) => ({ data: [], borderWidth: 1.6, pointRadius: 0, tension: 0.25, ...dataset })),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            // Warna dibalik supaya tooltip tetap kebaca di tema terang dan gelap
            backgroundColor: colors.ink,
            titleColor: colors.panel,
            bodyColor: colors.panel,
            padding: 8,
            cornerRadius: 4,
            boxPadding: 4,
          },
        },
        scales: {
          x: {
            grid: { display: false },
            border: { color: colors.grid },
            ticks: { maxTicksLimit: 6, maxRotation: 0, autoSkipPadding: 24 },
          },
          y: {
            grid: { color: colors.grid },
            border: { display: false },
            ticks: { maxTicksLimit: 5 },
          },
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
      { label: 'Index', borderColor: colors.warn },
    ], { y: { min: 0, max: 100, grid: { color: colors.grid }, border: { display: false }, ticks: { maxTicksLimit: 5 } } });
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

  // Chart prediksi: sumbu kiri kelas (0-2), sumbu kanan confidence (%)
  if (canvases.prediction) {
    charts.prediction = lineChart(canvases.prediction, [
      { label: 'Prediction', borderColor: colors.accent, stepped: true, tension: 0, yAxisID: 'y' },
      { label: 'Confidence (%)', borderColor: colors.ink3, borderDash: [4, 3], borderWidth: 1.2, yAxisID: 'percent' },
    ], {
      y: {
        min: -0.2,
        max: 2.2,
        grid: { color: colors.grid },
        border: { display: false },
        afterBuildTicks: (axis: { ticks: { value: number }[] }) => {
          axis.ticks = [0, 1, 2].map((value) => ({ value }));
        },
        ticks: { callback: (value: number | string) => PREDICTION_TICKS[Number(value)] ?? '' },
      },
      percent: percentAxis,
    });
  }

  return charts;
}


// History UI
export default function HistoryPanel({ latest }: { latest: Reading | null }) {
  const [minutes, setMinutes] = useState(30);
  const [error, setError] = useState('');
  const canvases = useRef<Record<ChartName, HTMLCanvasElement | null>>({
    score: null,
    turbidity: null,
    temperature: null,
    pumps: null,
    prediction: null,
  });
  const charts = useRef<Partial<Record<ChartName, Chart>>>({});
  const lastAddedId = useRef<number | null>(null); // id reading terakhir di chart, supaya tidak dobel

  useEffect(() => {
    const created = createCharts(canvases.current);
    charts.current = created;
    return () => {
      Object.values(created).forEach((chart) => chart?.destroy());
      charts.current = {};
    };
  }, []);

  useEffect(() => {
    let cancelled = false; // abaikan hasil request lama kalau rentang sudah diganti lagi

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
      .catch((loadError) => {
        if (!cancelled && !(loadError instanceof SignedOutError)) setError(`Could not load history: ${loadError.message}`);
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
      chart.update('none'); // tanpa animasi
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
            <button
              key={range.minutes}
              className={minutes === range.minutes ? 'active' : ''}
              onClick={() => setMinutes(range.minutes)}
            >
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
            <span className="key"><i style={{ background: 'var(--warn)' }} />index (0 clear, 100 dark)</span>
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
        <div className="chart wide">
          <h3>
            Model prediction
            <span className="key"><i style={{ background: 'var(--accent)' }} />condition</span>
            <span className="key"><i style={{ background: 'var(--ink-3)' }} />confidence %</span>
          </h3>
          {chartBox('prediction')}
        </div>
      </div>
    </section>
  );
}
