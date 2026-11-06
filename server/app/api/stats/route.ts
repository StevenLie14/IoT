import { requireAuth } from '@/lib/auth';
import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';

// Untuk dapetin berapa data yg udh masuk ke db
export async function GET(request: Request) {
  const denied = await requireAuth(request);
  if (denied) return denied;



  const totals = await query("SELECT COUNT(*) AS total, MIN(epoch) AS first, MAX(epoch) AS last, COUNT(*) FILTER (WHERE source = 'device') AS device FROM readings");

  const labels = await query("SELECT label, COUNT(*) AS count FROM readings WHERE label IS NOT NULL AND source = 'device' GROUP BY label ORDER BY label");

  const events = await query<{ total: number }>('SELECT COUNT(*) AS total FROM events');

  return Response.json({ ...totals.rows[0], events: events.rows[0].total, labels: labels.rows });
}
