'use client';

import { useEffect, useState } from 'react';

// Current time that re-renders every intervalMs, for "x seconds ago" labels
export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);

  return now;
}
