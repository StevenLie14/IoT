'use client';

import ControlPanel from './ControlPanel';
import DatasetPanel from './DatasetPanel';
import EventLog from './EventLog';
import HealthPanel from './HealthPanel';
import HistoryPanel from './HistoryPanel';
import ReadingsPanel from './ReadingsPanel';
import TopBar from './TopBar';
import { useLiveData } from '@/hooks/useLiveData';
import { useTheme } from '@/hooks/useTheme';
import type { LogEvent } from '@/lib/client/types';

const CHANGE_STATES = ['draining', 'settling', 'filling'];

function findLastChange(events: LogEvent[]) {
  return events.find((event) => event.type === 'state' && String(event.detail ?? '').startsWith('change done')) ?? null;
}

function findRunningPercent(events: LogEvent[], state: string | null | undefined) {
  if (!state || !CHANGE_STATES.includes(state)) return null;
  const started = events.find((event) => event.type === 'state' && CHANGE_STATES.includes(event.name ?? ''));
  return started?.value ?? null;
}

export default function Dashboard({ authEnabled }: { authEnabled: boolean }) {
  const live = useLiveData();
  const theme = useTheme();
  const { reading, health } = live;

  function saveLabel(label: string) {
    live.setHealth((current) => (current ? { ...current, label } : current));
  }

  return (
    <>
      <TopBar
        health={health}
        reading={reading}
        lastReadingAt={live.lastReadingAt}
        canSignOut={authEnabled}
        theme={theme.choice}
        onThemeChange={theme.changeTheme}
      />

      <main className="wrap">
        {live.error && <p className="panel-error">{live.error}</p>}

        <section className="overview">
          <HealthPanel reading={reading} lastChange={findLastChange(live.events)} />
          <ReadingsPanel key={theme.resolved} reading={reading} recent={live.recent} prediction={live.prediction} />
        </section>

        <section className="split">
          <ControlPanel
            reading={reading}
            latestEvent={live.events[0] ?? null}
            deviceOnline={health?.device === 'online'}
            runningPercent={findRunningPercent(live.events, reading?.state)}
          />
          <DatasetPanel stats={live.stats} label={health?.label ?? ''} onLabelSaved={saveLabel} />
        </section>

        <HistoryPanel key={theme.resolved} latest={reading} />
        <EventLog events={live.events} />
      </main>
    </>
  );
}
