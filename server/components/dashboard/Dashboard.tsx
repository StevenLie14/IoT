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


// cari kapan ganti air terakhir kali
function findLastChange(events: LogEvent[]) {
  return events.find((event) => event.type === 'state' && String(event.detail ?? '').startsWith('change done')) ?? null;
}

// Cari rule terakhir yang mulai ganti air otomatis (R1 score atau R4 model)
function findLastTrigger(events: LogEvent[]) {
  return events.find((event) => event.type === 'rule') ?? null;
}

export default function Dashboard({ authEnabled }: { authEnabled: boolean }) {
  const live = useLiveData();
  const theme = useTheme();
  const { reading, health } = live;

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
          {/* key = tema, jadi sparkline digambar ulang dengan warna baru waktu tema diganti */}
          <ReadingsPanel key={theme.resolved} reading={reading} recent={live.recent} prediction={live.prediction} />
        </section>

        <section className="split">
          <ControlPanel
            reading={reading}
            latestEvent={live.events[0] ?? null}
            deviceOnline={health?.device === 'online'}
          />
          <DatasetPanel
            stats={live.stats}
            label={health?.label ?? ''}
            recording={health?.recording ?? true}
            onLabelSaved={saveLabel}
            onRecordingSaved={saveRecording}
          />
        </section>

        <HistoryPanel key={`${theme.resolved}-${live.resetCount}`} latest={reading} />
        <EventLog events={live.events} />
      </main>
    </>
  );
}
