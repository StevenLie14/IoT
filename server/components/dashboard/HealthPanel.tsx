import { formatTime, scoreLevel, scoreText } from '@/lib/client/format';
import type { LogEvent, Reading } from '@/lib/client/types';

type Props = {
  reading: Reading | null
  lastChange: LogEvent | null
  lastTrigger: LogEvent | null
};


// UI Water health
export default function HealthPanel({ reading, lastChange, lastTrigger }: Props) {
  const score = reading?.score ?? null;
  const hasScore = score !== null;
  const meterWidth = hasScore ? Math.min(100, Math.max(0, score)) : 0; // panjang bar dalam persen

  let autoText = '--';
  if (reading) autoText = reading.auto ? 'On (AI model)' : 'Off';

  // Siapa yang terakhir mulai ganti air otomatis: model (R4) atau score (R1)
  let triggerText = '--';
  if (lastTrigger) {
    const trigger = lastTrigger.name === 'R4' ? 'AI model (R4)' : `Score rule (${lastTrigger.name})`;
    triggerText = `${trigger}, ${formatTime(lastTrigger.epoch)}`;
  }

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

        {/* <b> = garis di posisi 60 (batas ganti air) */}
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
          <dt>Last automatic trigger</dt>
          <dd>{triggerText}</dd>
        </dl>
      </div>
    </div>
  );
}
