import { requireAuth } from '@/lib/auth';
import { csvResponse, escapeCsv } from '@/lib/csv';
import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';

// Column Event Log
const HEADER = ['id', 'epoch', 'device_ts', 'type', 'name', 'value', 'detail', 'source'];

// Buat dapetin semua event log
export async function GET(request: Request) {
  const denied = await requireAuth(request);
  if (denied) return denied;

  const result = await query('SELECT * FROM events ORDER BY id');
  const lines = [HEADER.join(',')];
  for (const row of result.rows) {
    lines.push(HEADER.map((column) => escapeCsv(row[column])).join(','));
  }
  return csvResponse(lines, 'iot_project_events.csv');
}
