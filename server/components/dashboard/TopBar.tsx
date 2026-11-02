'use client';

import ThemeToggle from './ThemeToggle';
import { useNow } from '@/hooks/useNow';
import type { ThemeChoice } from '@/hooks/useTheme';
import type { Health, Reading } from '@/lib/client/types';

type Props = {
  health: Health | null;
  reading: Reading | null;
  lastReadingAt: number;
  canSignOut: boolean;
  theme: ThemeChoice;
  onThemeChange: (choice: ThemeChoice) => void;
};

function lastReadingText(lastReadingAt: number, now: number) {
  if (!lastReadingAt) return 'No readings yet';
  const seconds = Math.max(0, Math.round((now - lastReadingAt) / 1000));
  if (seconds < 60) return `Last reading ${seconds}s ago`;
  return `Last reading ${Math.round(seconds / 60)} min ago`;
}

function modeName(reading: Reading | null) {
  if (!reading) return '--';
  if (reading.demo) return 'Demo';
  if (reading.auto) return 'Auto';
  return 'Manual';
}

export default function TopBar({ health, reading, lastReadingAt, canSignOut, theme, onThemeChange }: Props) {
  const now = useNow();
  const deviceOnline = health?.device === 'online';

  const tagClass = reading?.auto ? 'tag accent' : 'tag';

  async function signOut() {
    await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
    window.location.href = '/login';
  }

  return (
    <header className="topbar">
      <div className="brand">
        IoT Project <small>Tank 01</small>
      </div>

      <div className="conn" aria-label="Connection status">
        <span>
          <i className={`dot ${health ? (deviceOnline ? 'on' : 'off') : ''}`} />
          {deviceOnline ? 'ESP32 online' : 'ESP32 offline'}
        </span>
        <span>
          <i className={`dot ${health ? (health.mqtt ? 'on' : 'off') : ''}`} />
          {health?.mqtt ? 'MQTT connected' : 'MQTT down'}
        </span>
        <span className="hide-sm muted">{lastReadingText(lastReadingAt, now)}</span>
      </div>

      <div className="right">
        <ThemeToggle choice={theme} onChange={onThemeChange} />
        <span className={tagClass}>{modeName(reading)}</span>
        {canSignOut && (
          <button className="linkbtn" onClick={signOut}>
            Sign out
          </button>
        )}
      </div>
    </header>
  );
}
