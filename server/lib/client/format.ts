export const LABEL_NAMES: Record<string, string> = {
  clear: 'Clear',
  slightly_turbid: 'Slightly turbid',
  dirty: 'Dirty',
};

export function formatNumber(value: number | null | undefined, digits = 1) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '--';
  return Number(value).toFixed(digits);
}

export function formatTime(epoch: number) {
  return new Date(epoch * 1000).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
}

export function scoreLevel(score: number) {
  if (score >= 80) return 'ok';
  if (score >= 60) return 'warn';
  return 'bad';
}

export function scoreText(score: number) {
  if (score >= 80) return 'Good';
  if (score >= 60) return 'Fair';
  return 'Poor, change due';
}

export function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
