import type { Level, Range } from '@/lib/client/ranges';

type Props = {
  value: number | null | undefined;
  range: Range;
  level: Level;
  unit?: string;
};

// Position of a value on the bar, clamped to 0-100 %
function toPercent(value: number, range: Range) {
  const ratio = (value - range.min) / (range.max - range.min);
  return Math.min(100, Math.max(0, ratio * 100));
}

// Horizontal scale with the normal band shaded and a marker at the current value
export default function RangeBar({ value, range, level, unit = '' }: Props) {
  const bandLeft = toPercent(range.normalLow, range);
  const bandWidth = toPercent(range.normalHigh, range) - bandLeft;
  const hasValue = value !== null && value !== undefined;

  return (
    <div className={`range ${level}`} title={`Normal ${range.normalLow}–${range.normalHigh}${unit}`}>
      <div className="range-track">
        <span className="range-band" style={{ left: `${bandLeft}%`, width: `${bandWidth}%` }} />
        {hasValue && <span className="range-marker" style={{ left: `${toPercent(value, range)}%` }} />}
      </div>
      <div className="range-scale">
        <span>{range.min}</span>
        <span>normal {range.normalLow}–{range.normalHigh}</span>
        <span>{range.max}</span>
      </div>
    </div>
  );
}
