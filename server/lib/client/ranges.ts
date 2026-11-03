// Scale and thresholds for one sensor: normal band, and alarm limits beyond it
export type Range = {
  min: number;
  max: number;
  normalLow: number;
  normalHigh: number;
  alarmLow?: number;
  alarmHigh?: number;
};

// Kept in line with the scoring in the firmware (computeScore)
export const RANGES = {
  temperature: { min: 15, max: 35, normalLow: 24, normalHigh: 30, alarmLow: 20, alarmHigh: 34 },
  tds: { min: 0, max: 1000, normalLow: 0, normalHigh: 300, alarmHigh: 700 },
  turbidity: { min: 0, max: 100, normalLow: 0, normalHigh: 25, alarmHigh: 60 },
} satisfies Record<string, Range>;

export type Level = 'normal' | 'warn' | 'bad';

// normal / warn / bad for a value, used to colour the range bars
export function levelFor(value: number | null | undefined, range: Range): Level {
  if (value === null || value === undefined) return 'normal';
  if (range.alarmLow !== undefined && value <= range.alarmLow) return 'bad';
  if (range.alarmHigh !== undefined && value >= range.alarmHigh) return 'bad';
  if (value < range.normalLow || value > range.normalHigh) return 'warn';
  return 'normal';
}
