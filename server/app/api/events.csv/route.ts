import { requireAuth } from '@/lib/auth';
import { csvResponse, esc } from '@/lib/csv';
import { q } from '@/lib/db';
export const dynamic = 'force-dynamic';
export async function GET(req: Request) {
  const denied = await requireAuth(req); if (denied) return denied;
  const { rows } = await q('SELECT * FROM events ORDER BY id');
  const head = ['id', 'epoch', 'device_ts', 'type', 'name', 'value', 'detail', 'source'];
  return csvResponse([head.join(','), ...rows.map((r) => head.map((h) => esc(r[h])).join(','))], 'aquaguard_events.csv');
}
