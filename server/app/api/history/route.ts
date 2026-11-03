import { requireAuth } from '@/lib/auth';
import { now, q } from '@/lib/db';

export const dynamic = 'force-dynamic';

const MAX_POINTS = 1500;            // more points than this only slows the chart down
const MAX_MINUTES = 60 * 24 * 30;   // 30 days

// Readings of the last ?minutes= for the history chart, thinned to about MAX_POINTS points
export async function GET(request: Request) {
  const denied = await requireAuth(request);
  if (denied) return denied;

  const requested = Number(new URL(request.url).searchParams.get('minutes')) || 30;
  const minutes = Math.min(Math.max(requested, 1), MAX_MINUTES);
  const since = now() - minutes * 60;

  // Keep every step-th reading, so long ranges still return about MAX_POINTS rows
  const countResult = await q<{ n: number }>('SELECT COUNT(*) AS n FROM readings WHERE epoch >= $1', [since]);
  const step = Math.max(1, Math.ceil(countResult.rows[0].n / MAX_POINTS));

  const result = await q(
    `SELECT * FROM (
       SELECT *, ROW_NUMBER() OVER (ORDER BY epoch) AS rn FROM readings WHERE epoch >= $1
     ) numbered
     WHERE (rn - 1) % $2 = 0
     ORDER BY epoch`,
    [since, step],
  );
  return Response.json(result.rows);
}
