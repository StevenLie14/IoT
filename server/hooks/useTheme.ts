'use client';

import { useEffect, useState } from 'react';

export type ThemeChoice = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'iot-project-theme';

// Theme saved in this browser, or "system" when none is saved
function readStoredChoice(): ThemeChoice {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {}
  return 'system';
}

function systemPrefersDark() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

// Light / dark / system theme: applies it to <html data-theme> and remembers it in localStorage
export function useTheme() {
  const [choice, setChoice] = useState<ThemeChoice>('system');
  const [systemDark, setSystemDark] = useState(false);

  useEffect(() => {
    setChoice(readStoredChoice());
    setSystemDark(systemPrefersDark());

    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setSystemDark(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  // Switches theme and saves the choice
  function changeTheme(next: ThemeChoice) {
    setChoice(next);
    const root = document.documentElement;
    if (next === 'system') delete root.dataset.theme;
    else root.dataset.theme = next;

    try {
      if (next === 'system') localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, next);
    } catch {}
  }

  const resolved = choice === 'system' ? (systemDark ? 'dark' : 'light') : choice;
  return { choice, resolved, changeTheme };
}
