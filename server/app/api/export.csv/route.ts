import { requireAuth } from '@/lib/auth';
import { csvResponse, esc, wib } from '@/lib/csv';
import { COLS, q } from '@/lib/db';
export const dynamic = 'force-dynamic';
export async function GET(req: Request) {
  const denied = await requireAuth(req); if (denied) return denied;
  const src = new URL(req.url).searchParams.get('source');
  const { rows } = await q(`SELECT * FROM readings ${src ? 'WHERE source = $1' : ''} ORDER BY id`, src ? [src] : []);
  const head = ['id', 'timestamp_wib', 'epoch', 'device_ts', ...COLS, 'label', 'source'];
  const lines = [head.join(',')];
  for (const r of rows) lines.push([r.id, wib(r.epoch), r.epoch, r.device_ts, ...COLS.map((c) => r[c]), r.label, r.source].map(esc).join(','));
  return csvResponse(lines, `aquaguard_dataset_${new Date().toISOString().slice(0, 10)}.csv`);
}
