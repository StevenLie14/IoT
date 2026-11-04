import { Pool, types } from 'pg';

// Return BIGINT columns (ids, epochs, counts) as numbers instead of strings
types.setTypeParser(20, (value) => Number(value));

// One connection pool for the whole process, kept on globalThis so hot reload does not open new ones
const globalForDb = globalThis as unknown as { iotProjectPool?: Pool };

if (!globalForDb.iotProjectPool) {
  globalForDb.iotProjectPool = process.env.DATABASE_URL
    ? new Pool({ connectionString: process.env.DATABASE_URL })
    : new Pool();
  globalForDb.iotProjectPool.on('error', (error) => console.error('PostgreSQL error:', error.message));
}

export const pool = globalForDb.iotProjectPool;

// Runs one SQL query with $1, $2, ... parameters
export function q<T extends Record<string, any> = Record<string, any>>(sql: string, params: unknown[] = []) {
  return pool.query<T>(sql, params);
}

// Reading fields stored as columns, in the same order as the insert statement
export const COLS = [
  't_tank', 'tds', 'tds_v', 'turb', 'turb_v', 'f_top', 'f_bot',
  'score', 'state', 'drain', 'fill', 'buzzer', 'auto', 'ml',
] as const;

export const TEXT_COLS = new Set(['state', 'ml']);

// Creates the tables on first start; safe to run again on every start
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS readings (
    id BIGSERIAL PRIMARY KEY,
    epoch BIGINT NOT NULL,
    device_ts BIGINT,
    t_tank DOUBLE PRECISION, tds DOUBLE PRECISION, tds_v DOUBLE PRECISION,
    turb DOUBLE PRECISION, turb_v DOUBLE PRECISION,
    f_top SMALLINT, f_bot SMALLINT,
    score SMALLINT, state TEXT, drain SMALLINT, fill SMALLINT,
    buzzer SMALLINT, auto SMALLINT,
    ml TEXT,
    label TEXT,
    source TEXT
  );
  ALTER TABLE readings ADD COLUMN IF NOT EXISTS ml TEXT;
  ALTER TABLE readings DROP COLUMN IF EXISTS demo;
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

// Retries until PostgreSQL accepts connections (it may start after the app in Docker), then creates the schema
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

// Saves one event row; a failure is only logged so it never breaks MQTT handling
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

// Reads one value from the settings table, or null when it was never saved
export async function readSetting(key: string) {
  const result = await q<{ value: string }>('SELECT value FROM settings WHERE key = $1', [key]);
  return result.rows[0]?.value ?? null;
}

// Saves one key/value in the settings table (insert or overwrite)
export async function saveSetting(key: string, value: string) {
  await q(
    'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
    [key, value],
  );
}

// Converts a JSON value to a number, or null when it is missing or not a number
export function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? null : parsed;
}

// Current Unix time in seconds
export function now() {
  return Math.floor(Date.now() / 1000);
}
