'use client';

import { useCallback, useEffect, useState } from 'react';
import { SignedOutError, api } from '@/lib/client/api';
import type { Health, LogEvent, Prediction, Reading, Stats } from '@/lib/client/types';

type LatestResponse = {
  reading: Reading | null
  health: Health
};

const MAX_EVENTS = 200;
const MAX_RECENT = 60;

export function useLiveData() {
  const [reading, setReading] = useState<Reading | null>(null);
  const [recent, setRecent] = useState<Reading[]>([]);
  const [lastReadingAt, setLastReadingAt] = useState(0);
  const [health, setHealth] = useState<Health | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [error, setError] = useState('');
  const [resetCount, setResetCount] = useState(0);

  const refreshStats = useCallback(async () => {
    setStats(await api<Stats>('/api/stats'));
  }, []);

  // Tambahin data masuk ke recent
  const addReading = useCallback((next: Reading) => {
    setReading(next);
    setLastReadingAt(Date.now());
    setRecent((list) => [...list, next].slice(-MAX_RECENT));
    // Jumlah record langsung ditambah, tidak nunggu refresh stats berikutnya
    if (next.stored !== 0) {
      setStats((current) => {
        if (!current) return current;
        return { ...current, total: current.total + 1, device: current.device + 1, first: current.first ?? next.epoch };
      });
    }
  }, []);

  useEffect(() => {
    let cancelled = false; // true kalau halaman sudah ditutup sebelum data selesai di-load

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
      } catch (loadError) {
        if (!(loadError instanceof SignedOutError)) setError(`Could not load data: ${(loadError as Error).message}`);
      }
    }

    loadInitialData();

    // Real time datanya (SSE)
    const stream = new EventSource('/api/stream');
    stream.addEventListener('reading', (message) => addReading(JSON.parse(message.data)));
    stream.addEventListener('health', (message) => setHealth(JSON.parse(message.data)));
    stream.addEventListener('event', (message) => {
      const event = JSON.parse(message.data);
      setEvents((list) => [event, ...list].slice(0, MAX_EVENTS)); // event terbaru di paling atas
    });

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

  // Prediksi model dari reading terakhir (ml = kelas, ml_conf = confidence 0-1)
  const prediction: Prediction | null = reading?.ml
    ? { prediction: reading.ml, confidence: reading.ml_conf ?? null, source: 'random forest on ESP32' }
    : null;

  return {
    reading,
    recent,
    lastReadingAt,
    health,
    setHealth,
    stats,
    events,
    error,
    resetCount,
    prediction,
  };
}
