import { requireAuth } from '@/lib/auth';
import { csvResponse, escapeCsv, toWib } from '@/lib/csv';
import { q } from '@/lib/db';

export const dynamic = 'force-dynamic';

// Only what the model needs: the water sensors and the label
const DATA_COLUMNS = ['t_tank', 'tds', 'tds_v', 'turb', 'turb_v', 'label'];

// Readings while a pump runs, and for this many seconds after, are disturbed by bubbles and stirring
const PUMP_QUIET_SEC = 5;

// Downloads the readings as the dataset CSV used by the ML scripts (?source=device by default).
// Pump rows are left out here because the CSV no longer has the pump columns to filter on.
export async function GET(request: Request) {
  const denied = await requireAuth(request);
  if (denied) return denied;

  const source = new URL(request.url).searchParams.get('source') || 'device';
  const result = await q(
    `SELECT r.* FROM readings r
     WHERE r.source = $1
       AND NOT EXISTS (
         SELECT 1 FROM readings p
         WHERE p.source = r.source
           AND (p.drain = 1 OR p.fill = 1)
           AND p.epoch BETWEEN r.epoch - $2 AND r.epoch
       )
     ORDER BY r.id`,
    [source, PUMP_QUIET_SEC],
  );

  const lines = [['timestamp_wib', ...DATA_COLUMNS].join(',')];
  for (const row of result.rows) {
    const values = [toWib(row.epoch), ...DATA_COLUMNS.map((column) => row[column])];
    lines.push(values.map(escapeCsv).join(','));
  }

  const date = new Date().toISOString().slice(0, 10);
  return csvResponse(lines, `iot_project_dataset_${date}.csv`);
}
