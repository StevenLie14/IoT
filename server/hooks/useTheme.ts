'use client';

import { useEffect, useState } from 'react';

// Theme user
export type ThemeChoice = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'iot-project-theme';

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

export function useTheme() {
  const [choice, setChoice] = useState<ThemeChoice>('system');
  const [systemDark, setSystemDark] = useState(false);

  useEffect(() => {
    setChoice(readStoredChoice());
    setSystemDark(systemPrefersDark());

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setSystemDark(mediaQuery.matches);
    mediaQuery.addEventListener('change', onChange);
    return () => mediaQuery.removeEventListener('change', onChange);
  }, []);

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
