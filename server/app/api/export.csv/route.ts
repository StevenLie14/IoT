import { requireAuth } from '@/lib/auth';
import { csvResponse, escapeCsv, toWib } from '@/lib/csv';
import { COLS, q } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const denied = await requireAuth(request);
  if (denied) return denied;

  const source = new URL(request.url).searchParams.get('source');
  const result = source
    ? await q('SELECT * FROM readings WHERE source = $1 ORDER BY id', [source])
    : await q('SELECT * FROM readings ORDER BY id');

  const header = ['id', 'timestamp_wib', 'epoch', 'device_ts', ...COLS, 'label', 'source'];
  const lines = [header.join(',')];
  for (const row of result.rows) {
    const values = [row.id, toWib(row.epoch), row.epoch, row.device_ts, ...COLS.map((column) => row[column]), row.label, row.source];
    lines.push(values.map(escapeCsv).join(','));
  }

  const date = new Date().toISOString().slice(0, 10);
  return csvResponse(lines, `aquaguard_dataset_${date}.csv`);
}
