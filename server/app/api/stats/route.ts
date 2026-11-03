import { requireAuth } from '@/lib/auth';
import { q } from '@/lib/db';

export const dynamic = 'force-dynamic';

// Dataset counts for the Dataset panel: rows per source, rows per label, number of events
export async function GET(request: Request) {
  const denied = await requireAuth(request);
  if (denied) return denied;

  const totals = await q(`
    SELECT COUNT(*) AS n,
           MIN(epoch) AS first,
           MAX(epoch) AS last,
           COUNT(*) FILTER (WHERE source = 'device') AS device,
           COUNT(*) FILTER (WHERE source = 'sim') AS sim
    FROM readings`);

  const labels = await q(`
    SELECT label, COUNT(*) AS n
    FROM readings
    WHERE label IS NOT NULL AND source = 'device'
    GROUP BY label
    ORDER BY label`);

  const events = await q<{ n: number }>('SELECT COUNT(*) AS n FROM events');

  return Response.json({ ...totals.rows[0], events: events.rows[0].n, labels: labels.rows });
}
