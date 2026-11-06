'use client';

import ThemeToggle from './ThemeToggle';
import { useNow } from '@/hooks/useNow';
import type { ThemeChoice } from '@/hooks/useTheme';
import type { Health } from '@/lib/client/types';

type Props = {
  health: Health | null
  lastReadingAt: number
  canSignOut: boolean
  theme: ThemeChoice
  onThemeChange: (choice: ThemeChoice) => void
};

// Navbar
function lastReadingText(lastReadingAt: number, now: number) {
  if (!lastReadingAt) return 'No readings yet';
  const seconds = Math.max(0, Math.round((now - lastReadingAt) / 1000));
  if (seconds < 60) return `Last reading ${seconds}s ago`;
  return `Last reading ${Math.round(seconds / 60)} min ago`;
}

export default function TopBar({ health, lastReadingAt, canSignOut, theme, onThemeChange }: Props) {
  const now = useNow();
  const deviceOnline = health?.device === 'online';

  async function signOut() {
    await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
    window.location.href = '/login';
  }

  return (
    <header className="topbar">
      <div className="brand">
        Water Quality Monitor
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
        {canSignOut && (
          <button className="linkbtn" onClick={signOut}>
            Sign out
          </button>
        )}
      </div>
    </header>
  );
}
