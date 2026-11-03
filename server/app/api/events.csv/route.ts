import { requireAuth } from '@/lib/auth';
import { csvResponse, escapeCsv } from '@/lib/csv';
import { q } from '@/lib/db';

export const dynamic = 'force-dynamic';

const HEADER = ['id', 'epoch', 'device_ts', 'type', 'name', 'value', 'detail', 'source'];

// Downloads the whole event log as CSV
export async function GET(request: Request) {
  const denied = await requireAuth(request);
  if (denied) return denied;

  const result = await q('SELECT * FROM events ORDER BY id');
  const lines = [HEADER.join(',')];
  for (const row of result.rows) {
    lines.push(HEADER.map((column) => escapeCsv(row[column])).join(','));
  }
  return csvResponse(lines, 'iot_project_events.csv');
}
