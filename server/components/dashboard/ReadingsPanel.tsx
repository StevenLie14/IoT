import RangeBar from './RangeBar';
import Sparkline from './Sparkline';
import { RANGES, levelFor } from '@/lib/client/ranges';
import { LABEL_NAMES, formatNumber } from '@/lib/client/format';
import type { Prediction, Reading } from '@/lib/client/types';

type Props = {
  reading: Reading | null;
  recent: Reading[];
  prediction: Prediction | null;
};

function pumpText(reading: Reading | null) {
  if (reading?.drain) return `draining ${formatNumber(reading.flow, 2)} L/min`;
  if (reading?.fill) return 'refilling';
  return 'pump idle';
}

function predictionText(prediction: Prediction) {
  const hasConfidence = prediction.confidence !== undefined && prediction.confidence !== null;
  if (!hasConfidence) return prediction.source;
  return `${prediction.source} · ${Math.round(prediction.confidence! * 100)}%`;
}

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
        <span className="sub">tank water</span>
        <RangeBar value={reading?.t_tank} range={RANGES.temperature} level={temperatureLevel} unit=" °C" />
        <Sparkline values={recent.map((row) => row.t_tank)} />
      </div>

      <div className={`reading ${tdsLevel}`}>
        <span className="label">Dissolved solids</span>
        <div className="value">
          <span className="num">{formatNumber(reading?.tds, 0)}</span>
          <span className="unit">ppm</span>
        </div>
        <span className="sub">probe {formatNumber(reading?.tds_v, 3)} V</span>
        <RangeBar value={reading?.tds} range={RANGES.tds} level={tdsLevel} unit=" ppm" />
        <Sparkline values={recent.map((row) => row.tds)} />
      </div>

      <div className={`reading ${turbidityLevel}`}>
        <span className="label">Turbidity</span>
        <div className="value">
          <span className="num">{formatNumber(reading?.turb, 0)}</span>
          <span className="unit">/ 100</span>
        </div>
        <span className="sub">sensor {formatNumber(reading?.turb_v, 2)} V</span>
        <RangeBar value={reading?.turb} range={RANGES.turbidity} level={turbidityLevel} />
        <Sparkline values={recent.map((row) => row.turb)} />
      </div>

      <div className="reading">
        <span className="label">Drained this change</span>
        <div className="value">
          <span className="num">{formatNumber(reading?.vol_ml, 0)}</span>
          <span className="unit">ml</span>
        </div>
        <span className="sub">{pumpText(reading)}</span>
        <Sparkline values={recent.map((row) => row.vol_ml)} />
      </div>

      <div className={`reading model ${prediction?.prediction ?? ''}`}>
        <span className="label">Condition (model)</span>
        <div className="value">
          <span className="word">{prediction ? LABEL_NAMES[prediction.prediction] ?? prediction.prediction : '--'}</span>
        </div>
        <span className="sub">{prediction ? predictionText(prediction) : 'no model loaded'}</span>
      </div>
    </div>
  );
}
