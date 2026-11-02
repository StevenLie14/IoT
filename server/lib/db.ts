// PostgreSQL access. Connection comes from PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE
// (or DATABASE_URL).
import { Pool, types } from 'pg';

types.setTypeParser(20, (v) => Number(v));   // BIGINT and COUNT(*) as numbers, not strings

const g = globalThis as unknown as { __aquaguardPool?: Pool };
export const pool: Pool = (g.__aquaguardPool ??= process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL })
  : new Pool());
pool.on('error', (e) => console.error('PostgreSQL error:', e.message));

export const q = <T extends Record<string, unknown> = Record<string, any>>(sql: string, params: unknown[] = []) =>
  pool.query<T>(sql, params);

export const COLS = ['t_tank', 't_res', 'tds', 'tds_v', 'turb', 'turb_v', 'ph', 'ph_v', 'flow', 'vol_ml', 'f_top', 'f_bot',
  'score', 'state', 'drain', 'fill', 'feeder', 'buzzer', 'auto', 'demo', 'fault', 'ml'] as const;
export const TEXT_COLS = new Set(['state', 'fault', 'ml']);

export async function initDb() {
  await q(`
    CREATE TABLE IF NOT EXISTS readings (
      id BIGSERIAL PRIMARY KEY,
      epoch BIGINT NOT NULL,             -- server receive time (unix s)
      device_ts BIGINT,                  -- ESP32 NTP time (0 if not synced)
      t_tank DOUBLE PRECISION, t_res DOUBLE PRECISION, tds DOUBLE PRECISION, tds_v DOUBLE PRECISION,
      turb DOUBLE PRECISION, turb_v DOUBLE PRECISION, ph DOUBLE PRECISION, ph_v DOUBLE PRECISION,
      flow DOUBLE PRECISION, vol_ml DOUBLE PRECISION, f_top SMALLINT, f_bot SMALLINT,
      score SMALLINT, state TEXT, drain SMALLINT, fill SMALLINT, feeder SMALLINT,
      buzzer SMALLINT, auto SMALLINT, demo SMALLINT, fault TEXT,
      ml TEXT,                           -- prediction made on the ESP32 (decision tree)
      label TEXT,                        -- condition label set on the dashboard (for ML)
      source TEXT                        -- 'device' or 'sim'
    );
    ALTER TABLE readings ADD COLUMN IF NOT EXISTS ml TEXT;
    CREATE TABLE IF NOT EXISTS events (
      id BIGSERIAL PRIMARY KEY,
      epoch BIGINT NOT NULL, device_ts BIGINT,
      type TEXT, name TEXT, value DOUBLE PRECISION, detail TEXT, source TEXT
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE INDEX IF NOT EXISTS idx_readings_epoch ON readings(epoch);
    CREATE INDEX IF NOT EXISTS idx_events_epoch ON events(epoch);
  `);
}

// The database container may still be starting: retry for about a minute
export async function waitForDb() {
  for (let i = 1; ; i++) {
    try { await initDb(); return; } catch (e) {
      if (i >= 30) throw e;
      console.log(`Waiting for PostgreSQL (${(e as Error).message})...`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

export const insertReadingSql = `INSERT INTO readings (epoch, device_ts, ${COLS.join(',')}, label, source)
  VALUES (${Array.from({ length: COLS.length + 4 }, (_, i) => `$${i + 1}`).join(',')}) RETURNING id`;

export function logEvent(epoch: number, deviceTs: number | null, type: string, name: string | null,
  value: number | null, detail: string | null, source: string) {
  return q('INSERT INTO events (epoch, device_ts, type, name, value, detail, source) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [epoch, deviceTs, type, name, value, detail, source]).catch((e) => console.error('Event not saved:', e.message));
}

export const num = (v: unknown): number | null =>
  v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v);
export const now = () => Math.floor(Date.now() / 1000);
