'use client';

import { useState } from 'react';
import { post } from '@/lib/client/api';
import { LABEL_NAMES } from '@/lib/client/format';
import type { Stats } from '@/lib/client/types';

type Props = {
  stats: Stats | null;
  label: string;
  onLabelSaved: (label: string) => void;
};

const TARGET_ROWS = 1000;
const LABEL_OPTIONS = ['', 'clear', 'slightly_turbid', 'dirty'];

export default function DatasetPanel({ stats, label, onLabelSaved }: Props) {
  const [message, setMessage] = useState('');
  const deviceRows = stats?.device ?? 0;
  const progress = Math.min(100, (deviceRows / TARGET_ROWS) * 100);

  let progressText = `${(TARGET_ROWS - deviceRows).toLocaleString()} more to reach 1,000`;
  if (deviceRows >= TARGET_ROWS) progressText = 'Target of 1,000 records reached';
  if (stats?.sim) progressText += ` · ${stats.sim.toLocaleString()} simulator rows excluded`;

  async function chooseLabel(next: string) {
    onLabelSaved(next);
    try {
      await post('/api/label', { label: next });
      setMessage(next ? `New readings are labelled "${LABEL_NAMES[next]}"` : 'Labelling is off');
    } catch (err) {
      setMessage(`Could not save the label: ${(err as Error).message}`);
    }
  }

  return (
    <div className="panel dataset">
      <header>
        <h2>Dataset</h2>
        <span className="muted">{stats?.first ? `since ${new Date(stats.first * 1000).toLocaleDateString()}` : ''}</span>
      </header>
      <div className="body">
        <div className="count">
          <span className="num">{stats ? deviceRows.toLocaleString() : '--'}</span>
          <span className="muted">device records</span>
        </div>
        <div className="progress" aria-hidden="true">
          <i style={{ width: `${progress}%` }} />
        </div>
        <span className="muted small">{progressText}</span>

        <div className="control-group">
          <span className="title">Label new readings</span>
          <div className="segmented" id="labels" role="radiogroup" aria-label="Condition label">
            {LABEL_OPTIONS.map((option) => (
              <label key={option || 'none'}>
                <input type="radio" name="label" value={option} checked={label === option}
                  onChange={() => chooseLabel(option)} />
                <span>{option ? LABEL_NAMES[option] : 'None'}</span>
              </label>
            ))}
          </div>
          <p className="help">Match the label to the water in the tank while recording. The classifier learns from these rows.</p>
          {stats && stats.labels.length > 0 && (
            <p className="help num">
              {stats.labels.map((item) => `${LABEL_NAMES[item.label] ?? item.label}: ${item.n}`).join('   ')}
            </p>
          )}
          {message && <p className="help">{message}</p>}
        </div>

        <div className="downloads">
          <a href="/api/export.csv?source=device">Device CSV</a>
          <a href="/api/export.csv">All rows</a>
          <a href="/api/events.csv">Event log CSV</a>
        </div>
      </div>
    </div>
  );
}
