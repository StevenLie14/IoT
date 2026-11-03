'use client';

import type { ThemeChoice } from '@/hooks/useTheme';

// One small button that cycles Auto -> Light -> Dark
const NEXT: Record<ThemeChoice, ThemeChoice> = { system: 'light', light: 'dark', dark: 'system' };
const NAME: Record<ThemeChoice, string> = { system: 'Auto', light: 'Light', dark: 'Dark' };

function Icon({ choice }: { choice: ThemeChoice }) {
  if (choice === 'light') {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="3" />
        <path d="M8 1.5v1.8M8 12.7v1.8M1.5 8h1.8M12.7 8h1.8M3.4 3.4l1.3 1.3M11.3 11.3l1.3 1.3M3.4 12.6l1.3-1.3M11.3 4.7l1.3-1.3" />
      </svg>
    );
  }
  if (choice === 'dark') {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M13 9.6A5.5 5.5 0 0 1 6.4 3a5.5 5.5 0 1 0 6.6 6.6z" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 2.5v11a5.5 5.5 0 0 0 0-11z" className="fill" />
    </svg>
  );
}

type Props = {
  choice: ThemeChoice;
  onChange: (choice: ThemeChoice) => void;
};

export default function ThemeToggle({ choice, onChange }: Props) {
  const label = `Theme: ${NAME[choice]} (click for ${NAME[NEXT[choice]]})`;
  return (
    <button className="theme-toggle" onClick={() => onChange(NEXT[choice])} title={label} aria-label={label}>
      <Icon choice={choice} />
    </button>
  );
}
