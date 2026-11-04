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

// Newest event that marks a finished water change, for the Health panel
function findLastChange(events: LogEvent[]) {
  return events.find((event) => event.type === 'state' && String(event.detail ?? '').startsWith('change done')) ?? null;
}

// Newest event where a rule (R1 score or R4 AI model) started a water change
function findLastTrigger(events: LogEvent[]) {
  return events.find((event) => event.type === 'rule') ?? null;
}

// The whole dashboard page: loads live data and lays out the panels
export default function Dashboard({ authEnabled }: { authEnabled: boolean }) {
  const live = useLiveData();
  const theme = useTheme();
  const { reading, health } = live;

  // Update the label/recording state on screen right away instead of waiting for the next health update
  function saveLabel(label: string) {
    live.setHealth((current) => (current ? { ...current, label } : current));
  }

  function saveRecording(recording: boolean) {
    live.setHealth((current) => (current ? { ...current, recording } : current));
  }

  return (
    <>
      <TopBar
        health={health}
        lastReadingAt={live.lastReadingAt}
        canSignOut={authEnabled}
        theme={theme.choice}
        onThemeChange={theme.changeTheme}
      />

      <main className="wrap">
        {live.error && <p className="panel-error">{live.error}</p>}

        <section className="overview">
          <HealthPanel reading={reading} lastChange={findLastChange(live.events)} lastTrigger={findLastTrigger(live.events)} />
          <ReadingsPanel key={theme.resolved} reading={reading} recent={live.recent} prediction={live.prediction} />
        </section>

        <section className="split">
          <ControlPanel
            reading={reading}
            latestEvent={live.events[0] ?? null}
            deviceOnline={health?.device === 'online'}
          />
          <DatasetPanel stats={live.stats} label={health?.label ?? ''} recording={health?.recording ?? true}
            onLabelSaved={saveLabel} onRecordingSaved={saveRecording} />
        </section>

        <HistoryPanel key={`${theme.resolved}-${live.resetCount}`} latest={reading} />
        <EventLog events={live.events} />
      </main>
    </>
  );
}
