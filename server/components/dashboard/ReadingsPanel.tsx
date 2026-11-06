import RangeBar from './RangeBar';
import Sparkline from './Sparkline';
import { RANGES, levelFor } from '@/lib/client/ranges';
import { LABEL_NAMES, formatNumber } from '@/lib/client/format';
import type { Prediction, Reading } from '@/lib/client/types';

type Props = {
  reading: Reading | null
  recent: Reading[]
  prediction: Prediction | null
};

// State pumpnya
function pumpText(reading: Reading | null) {
  if (reading?.drain) return 'draining to the bottom float';
  if (reading?.fill) return 'refilling to the top float';
  return 'pumps idle';
}

function floatsConflict(reading: Reading | null) {
  return Boolean(reading?.f_top && reading?.f_bot);
}

function levelText(reading: Reading | null) {
  if (!reading) return '--';
  if (floatsConflict(reading)) return 'check floats';
  if (reading.f_top) return 'full';
  if (reading.f_bot) return 'low';
  return 'normal';
}

function floatText(value: number | null | undefined) {
  if (value === null || value === undefined) return '--';
  return value ? 'triggered' : 'open';
}

// Teks kecil di card Condition, contoh "random forest on ESP32 · 92%"
function predictionText(prediction: Prediction) {
  const hasConfidence = prediction.confidence !== undefined && prediction.confidence !== null;
  if (!hasConfidence) return prediction.source;
  return `${prediction.source} · ${Math.round(prediction.confidence! * 100)}%`;
}

// UI Sensor
export default function ReadingsPanel({ reading, recent, prediction }: Props) {
  const temperatureLevel = levelFor(reading?.t_tank, RANGES.temperature);
  const tdsLevel = levelFor(reading?.tds, RANGES.tds);
  const turbidityLevel = levelFor(reading?.turb, RANGES.turbidity);

  return (
    <div className="panel readings">
      <div className={`reading ${temperatureLevel}`}>
        <span className="label">Temperature</span>
        <div className="value">
          <span className="num">{formatNumber(reading?.t_tank)}</span>
          <span className="unit">°C</span>
        </div>
        <RangeBar value={reading?.t_tank} range={RANGES.temperature} level={temperatureLevel} unit=" °C" />
        <Sparkline values={recent.map((row) => row.t_tank)} />
      </div>

      <div className={`reading ${tdsLevel}`}>
        <span className="label">Dissolved solids</span>
        <div className="value">
          <span className="num">{formatNumber(reading?.tds, 0)}</span>
          <span className="unit">ppm</span>
        </div>
        <RangeBar value={reading?.tds} range={RANGES.tds} level={tdsLevel} unit=" ppm" />
        <Sparkline values={recent.map((row) => row.tds)} />
      </div>

      <div className={`reading ${turbidityLevel}`}>
        <span className="label">Turbidity</span>
        <div className="value">
          <span className="num">{formatNumber(reading?.turb, 0)}</span>
          <span className="unit">/ 100</span>
        </div>
        <RangeBar value={reading?.turb} range={RANGES.turbidity} level={turbidityLevel} />
        <Sparkline values={recent.map((row) => row.turb)} />
      </div>

      <div className={`reading ${floatsConflict(reading) ? 'bad' : ''}`}>
        <span className="label">Water level</span>
        <div className="value">
          <span className="word">{levelText(reading)}</span>
        </div>
        <span className="sub">{pumpText(reading)}</span>
        <span className="sub floats">
          <span className={reading?.f_top ? 'on' : ''}>Top float: {floatText(reading?.f_top)}</span>
          <span className={reading?.f_bot ? 'on' : ''}>Bottom float: {floatText(reading?.f_bot)}</span>
        </span>
        {floatsConflict(reading) && (
          <span className="sub">Both floats read triggered at once: check the wiring or the signal direction in config.h</span>
        )}
      </div>

      {/* Card hasil model, cuma muncul kalau ESP32 mengirim field ml */}
      {prediction && (
        <div className={`reading model ${prediction.prediction}`}>
          <span className="label">Condition (model)</span>
          <div className="value">
            <span className="word">{LABEL_NAMES[prediction.prediction] ?? prediction.prediction}</span>
          </div>
          <span className="sub">{predictionText(prediction)}</span>
        </div>
      )}
    </div>
  );
}
