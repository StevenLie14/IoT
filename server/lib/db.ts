import { Pool, types } from 'pg';

types.setTypeParser(20, (value) => Number(value));

const globalForDb = globalThis as unknown as { aquaguardPool?: Pool };

if (!globalForDb.aquaguardPool) {
  globalForDb.aquaguardPool = process.env.DATABASE_URL
    ? new Pool({ connectionString: process.env.DATABASE_URL })
    : new Pool();
  globalForDb.aquaguardPool.on('error', (error) => console.error('PostgreSQL error:', error.message));
}

export const pool = globalForDb.aquaguardPool;

export function q<T extends Record<string, any> = Record<string, any>>(sql: string, params: unknown[] = []) {
  return pool.query<T>(sql, params);
}

export const COLS = [
  't_tank', 't_res', 'tds', 'tds_v', 'turb', 'turb_v', 'ph', 'ph_v', 'flow', 'vol_ml', 'f_top', 'f_bot',
  'score', 'state', 'drain', 'fill', 'feeder', 'buzzer', 'auto', 'demo', 'fault', 'ml',
] as const;

export const TEXT_COLS = new Set(['state', 'fault', 'ml']);

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS readings (
    id BIGSERIAL PRIMARY KEY,
    epoch BIGINT NOT NULL,
    device_ts BIGINT,
    t_tank DOUBLE PRECISION, t_res DOUBLE PRECISION, tds DOUBLE PRECISION, tds_v DOUBLE PRECISION,
    turb DOUBLE PRECISION, turb_v DOUBLE PRECISION, ph DOUBLE PRECISION, ph_v DOUBLE PRECISION,
    flow DOUBLE PRECISION, vol_ml DOUBLE PRECISION, f_top SMALLINT, f_bot SMALLINT,
    score SMALLINT, state TEXT, drain SMALLINT, fill SMALLINT, feeder SMALLINT,
    buzzer SMALLINT, auto SMALLINT, demo SMALLINT, fault TEXT,
    ml TEXT,
    label TEXT,
    source TEXT
  );
  ALTER TABLE readings ADD COLUMN IF NOT EXISTS ml TEXT;
  CREATE TABLE IF NOT EXISTS events (
    id BIGSERIAL PRIMARY KEY,
    epoch BIGINT NOT NULL,
    device_ts BIGINT,
    type TEXT, name TEXT, value DOUBLE PRECISION, detail TEXT, source TEXT
  );
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
  CREATE INDEX IF NOT EXISTS idx_readings_epoch ON readings(epoch);
  CREATE INDEX IF NOT EXISTS idx_events_epoch ON events(epoch);
`;

export async function waitForDb() {
  const attempts = 30;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await q(SCHEMA);
      return;
    } catch (error) {
      if (attempt === attempts) throw error;
      console.log(`Waiting for PostgreSQL (${(error as Error).message})...`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

const placeholders = Array.from({ length: COLS.length + 4 }, (_, index) => `$${index + 1}`).join(',');
export const insertReadingSql = `INSERT INTO readings (epoch, device_ts, ${COLS.join(',')}, label, source)
  VALUES (${placeholders}) RETURNING id`;

export async function logEvent(
  epoch: number,
  deviceTs: number | null,
  type: string,
  name: string | null,
  value: number | null,
  detail: string | null,
  source: string,
) {
  try {
    await q(
      'INSERT INTO events (epoch, device_ts, type, name, value, detail, source) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [epoch, deviceTs, type, name, value, detail, source],
    );
  } catch (error) {
    console.error('Event not saved:', (error as Error).message);
  }
}

export function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export function now() {
  return Math.floor(Date.now() / 1000);
}
