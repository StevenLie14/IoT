import { formatTime, scoreLevel, scoreText } from '@/lib/client/format';
import type { LogEvent, Reading } from '@/lib/client/types';

type Props = {
  reading: Reading | null;
  lastChange: LogEvent | null;
};

// Big health score with its meter, auto mode and the time of the last water change
export default function HealthPanel({ reading, lastChange }: Props) {
  const score = reading?.score ?? null;
  const hasScore = score !== null;
  const meterWidth = hasScore ? Math.min(100, Math.max(0, score)) : 0;

  let autoText = '--';
  if (reading) autoText = reading.auto ? (reading.demo ? 'On, demo timing' : 'On') : 'Off';

  let lastChangeText = '--';
  if (lastChange) lastChangeText = formatTime(lastChange.epoch);

  return (
    <div className={`panel score ${hasScore ? scoreLevel(score) : ''}`}>
      <header>
        <h2>Water health</h2>
      </header>
      <div className="body">
        <div className="score-row">
          <span className="score-value num">{hasScore ? score : '--'}</span>
          <span className="score-word">{hasScore ? scoreText(score) : 'Waiting for data'}</span>
        </div>

        <div className="meter" aria-hidden="true">
          <i style={{ width: `${meterWidth}%` }} />
          <b title="Water change threshold" />
        </div>
        <div className="meter-scale">
          <span style={{ left: 0 }}>0</span>
          <span style={{ left: '60%' }}>60</span>
          <span style={{ right: 0 }}>100</span>
        </div>

        <dl className="kv">
          <dt>Automatic change</dt>
          <dd>{autoText}</dd>
          <dt>Last water change</dt>
          <dd>{lastChangeText}</dd>
          {reading?.source === 'sim' && (<><dt>Source</dt><dd>Simulator</dd></>)}
        </dl>
      </div>
    </div>
  );
}
