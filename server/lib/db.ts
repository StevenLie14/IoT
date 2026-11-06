import { Pool, types } from 'pg';


// BIGINT dari Postgres diubah jadi number
types.setTypeParser(20, (value) => Number(value));

const globalForDatabase = globalThis as unknown as { iotProjectPool?: Pool };

// Connect ke Postgres DB
if (!globalForDatabase.iotProjectPool) {
  globalForDatabase.iotProjectPool = process.env.DATABASE_URL
    ? new Pool({ connectionString: process.env.DATABASE_URL })
    : new Pool();
  globalForDatabase.iotProjectPool.on('error', (error) => console.error('PostgreSQL error:', error.message));
}

export const pool = globalForDatabase.iotProjectPool;

export function query<T extends Record<string, any> = Record<string, any>>(sql: string, params: unknown[] = []) {
  return pool.query<T>(sql, params);
}

export const READING_COLUMNS = [
  't_tank', 'tds', 'tds_v', 'turb', 'turb_v', 'f_top', 'f_bot',
  'score', 'state', 'drain', 'fill', 'buzzer', 'auto', 'ml', 'ml_conf',
] as const;

export const TEXT_COLUMNS = new Set(['state', 'ml']);

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS readings (id BIGSERIAL PRIMARY KEY, epoch BIGINT NOT NULL, device_ts BIGINT, t_tank DOUBLE PRECISION, tds DOUBLE PRECISION, tds_v DOUBLE PRECISION, turb DOUBLE PRECISION, turb_v DOUBLE PRECISION, f_top SMALLINT, f_bot SMALLINT, score SMALLINT, state TEXT, drain SMALLINT, fill SMALLINT, buzzer SMALLINT, auto SMALLINT, ml TEXT, ml_conf DOUBLE PRECISION, label TEXT, source TEXT);
  ALTER TABLE readings DROP COLUMN IF EXISTS demo;
  ALTER TABLE readings ADD COLUMN IF NOT EXISTS ml TEXT;
  ALTER TABLE readings ADD COLUMN IF NOT EXISTS ml_conf DOUBLE PRECISION;
  CREATE TABLE IF NOT EXISTS events (id BIGSERIAL PRIMARY KEY, epoch BIGINT NOT NULL, device_ts BIGINT, type TEXT, name TEXT, value DOUBLE PRECISION, detail TEXT, source TEXT);
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
  CREATE INDEX IF NOT EXISTS idx_readings_epoch ON readings(epoch);
  CREATE INDEX IF NOT EXISTS idx_events_epoch ON events(epoch);
`;

export async function waitForDatabase() {
  const attempts = 30;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await query(SCHEMA);
      return;
    } catch (error) {
      if (attempt === attempts) throw error;
      console.log(`Waiting for PostgreSQL (${(error as Error).message})...`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

const placeholders = Array.from({ length: READING_COLUMNS.length + 4 }, (_, index) => `$${index + 1}`).join(',');
export const insertReadingSql = `INSERT INTO readings (epoch, device_ts, ${READING_COLUMNS.join(',')}, label, source) VALUES (${placeholders}) RETURNING id`;

export async function logEvent(
  epoch: number,
  deviceTimestamp: number | null,
  type: string,
  name: string | null,
  value: number | null,
  detail: string | null,
  source: string,
) {
  try {
    await query('INSERT INTO events (epoch, device_ts, type, name, value, detail, source) VALUES ($1, $2, $3, $4, $5, $6, $7)', [epoch, deviceTimestamp, type, name, value, detail, source]);
  } catch (error) {
    console.error('Event not saved:', (error as Error).message);
  }
}

export async function readSetting(key: string) {
  const result = await query<{ value: string }>('SELECT value FROM settings WHERE key = $1', [key]);
  return result.rows[0]?.value ?? null;
}

export async function saveSetting(key: string, value: string) {
  await query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [key, value]);
}

export function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export function now() {
  return Math.floor(Date.now() / 1000);
}
