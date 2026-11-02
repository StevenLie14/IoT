import { requireAuth } from '@/lib/auth';
import { q } from '@/lib/db';
export const dynamic = 'force-dynamic';
export async function GET(req: Request) {
  const denied = await requireAuth(req); if (denied) return denied;
  const { rows: [r] } = await q(`SELECT COUNT(*) AS n, MIN(epoch) AS first, MAX(epoch) AS last,
    COUNT(*) FILTER (WHERE source = 'device') AS device, COUNT(*) FILTER (WHERE source = 'sim') AS sim FROM readings`);
  const { rows: labels } = await q(`SELECT label, COUNT(*) AS n FROM readings
    WHERE label IS NOT NULL AND source = 'device' GROUP BY label ORDER BY label`);
  const { rows: [ev] } = await q<{ n: number }>('SELECT COUNT(*) AS n FROM events');
  return Response.json({ ...r, events: ev.n, labels });
}
