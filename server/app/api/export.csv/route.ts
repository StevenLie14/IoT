import { requireAuth } from '@/lib/auth';
import { csvResponse, escapeCsv, toWib } from '@/lib/csv';
import { q } from '@/lib/db';

export const dynamic = 'force-dynamic';

const DATA_COLUMNS = [
  't_tank', 'tds', 'tds_v', 'turb', 'turb_v', 'f_top', 'f_bot',
  'score', 'state', 'drain', 'fill', 'buzzer', 'auto', 'demo', 'label',
];

// Downloads the readings as the dataset CSV used by the ML scripts (?source=device by default)
export async function GET(request: Request) {
  const denied = await requireAuth(request);
  if (denied) return denied;

  const source = new URL(request.url).searchParams.get('source') || 'device';
  const result = await q('SELECT * FROM readings WHERE source = $1 ORDER BY id', [source]);

  const lines = [['timestamp_wib', ...DATA_COLUMNS].join(',')];
  for (const row of result.rows) {
    const values = [toWib(row.epoch), ...DATA_COLUMNS.map((column) => row[column])];
    lines.push(values.map(escapeCsv).join(','));
  }

  const date = new Date().toISOString().slice(0, 10);
  return csvResponse(lines, `iot_project_dataset_${date}.csv`);
}
