// Display names for the dataset labels
export const LABEL_NAMES: Record<string, string> = {
  clear: 'Clear',
  slightly_turbid: 'Slightly turbid',
  dirty: 'Dirty',
};

// Number with fixed decimals, or "--" when there is no value
export function formatNumber(value: number | null | undefined, digits = 1) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '--';
  return Number(value).toFixed(digits);
}

// Unix time to a 24-hour HH:MM:SS clock in the browser's time zone
export function formatTime(epoch: number) {
  return new Date(epoch * 1000).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
}

// Colour level for a health score (same 80 / 60 thresholds as the firmware)
export function scoreLevel(score: number) {
  if (score >= 80) return 'ok';
  if (score >= 60) return 'warn';
  return 'bad';
}

// Short description of a health score
export function scoreText(score: number) {
  if (score >= 80) return 'Good';
  if (score >= 60) return 'Fair';
  return 'Poor, change due';
}

// Reads a CSS custom property, used to give the charts the current theme colours
export function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
