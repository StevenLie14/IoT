'use client';

import type { ThemeChoice } from '@/hooks/useTheme';

const OPTIONS: { value: ThemeChoice; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'Auto' },
];

type Props = {
  choice: ThemeChoice;
  onChange: (choice: ThemeChoice) => void;
};

export default function ThemeToggle({ choice, onChange }: Props) {
  return (
    <div className="theme-toggle" role="group" aria-label="Color theme">
      {OPTIONS.map((option) => (
        <button key={option.value} aria-pressed={choice === option.value} onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}
