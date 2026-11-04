'use client';

import { useCallback, useEffect, useState } from 'react';
import { SignedOutError, api } from '@/lib/client/api';
import type { Health, LogEvent, Prediction, Reading, Stats } from '@/lib/client/types';

type LatestResponse = {
  reading: Reading | null;
  health: Health;
};

const MAX_EVENTS = 200;
const MAX_RECENT = 60;

// All live dashboard data: loads the current state once, then follows the server's SSE stream
export function useLiveData() {
  const [reading, setReading] = useState<Reading | null>(null);
  const [recent, setRecent] = useState<Reading[]>([]);
  const [lastReadingAt, setLastReadingAt] = useState(0);
  const [health, setHealth] = useState<Health | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [error, setError] = useState('');
  const [resetCount, setResetCount] = useState(0);

  // Re-fetches the dataset counts from the database
  const refreshStats = useCallback(async () => {
    setStats(await api<Stats>('/api/stats'));
  }, []);

  // Handles a new reading from the stream
  const addReading = useCallback((next: Reading) => {
    setReading(next);
    setLastReadingAt(Date.now());
    setRecent((list) => [...list, next].slice(-MAX_RECENT));
    // Keep the record count live instead of waiting for the next stats refresh
    if (next.stored !== 0) {
      setStats((current) => {
        if (!current) return current;
        const key = next.source === 'sim' ? 'sim' : 'device';
        return { ...current, n: current.n + 1, [key]: current[key] + 1, first: current.first ?? next.epoch };
      });
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    // Latest reading, last 10 minutes of history, recent events and dataset counts
    async function loadInitialData() {
      try {
        const latest = await api<LatestResponse>('/api/latest');
        const history = await api<Reading[]>('/api/history?minutes=10');
        const pastEvents = await api<LogEvent[]>('/api/events?limit=100');
        if (cancelled) return;

        setRecent(history.slice(-MAX_RECENT));
        if (latest.reading) {
          setReading(latest.reading);
          setLastReadingAt(Date.now());
        }
        setHealth(latest.health);
        setEvents(pastEvents);
        await refreshStats();
      } catch (err) {
        if (!(err instanceof SignedOutError)) setError(`Could not load data: ${(err as Error).message}`);
      }
    }

    loadInitialData();

    // Live updates pushed by the server
    const stream = new EventSource('/api/stream');
    stream.addEventListener('reading', (message) => addReading(JSON.parse(message.data)));
    stream.addEventListener('health', (message) => setHealth(JSON.parse(message.data)));
    stream.addEventListener('event', (message) => {
      const event = JSON.parse(message.data);
      setEvents((list) => [event, ...list].slice(0, MAX_EVENTS));
    });

    // All data was deleted: clear everything on screen and reload
    stream.addEventListener('reset', () => {
      setReading(null);
      setRecent([]);
      setLastReadingAt(0);
      setEvents([]);
      setResetCount((count) => count + 1);
      api<LogEvent[]>('/api/events?limit=100').then(setEvents).catch(() => {});
      refreshStats().catch(() => {});
    });

    const statsTimer = setInterval(() => refreshStats().catch(() => {}), 60000);

    return () => {
      cancelled = true;
      stream.close();
      clearInterval(statsTimer);
    };
  }, [addReading, refreshStats]);

  // Water condition predicted by the model running on the ESP32
  const prediction: Prediction | null = reading?.ml
    ? { prediction: reading.ml, confidence: reading.ml_conf ?? null, source: 'random forest on ESP32' }
    : null;

  return {
    reading,
    recent,
    lastReadingAt,
    health,
    setHealth,
    prediction,
    stats,
    events,
    error,
    resetCount,
  };
}
