import { requireAuth } from '@/lib/auth';
import { now, q } from '@/lib/db';
export const dynamic = 'force-dynamic';
export async function GET(req: Request) {
  const denied = await requireAuth(req); if (denied) return denied;
  const minutes = Math.min(Math.max(Number(new URL(req.url).searchParams.get('minutes')) || 30, 1), 60 * 24 * 30);
  const since = now() - minutes * 60;
  const maxPts = 1500;                       // thin out long ranges for the chart
  const { rows: [{ n }] } = await q<{ n: number }>('SELECT COUNT(*) AS n FROM readings WHERE epoch >= $1', [since]);
  const step = Math.max(1, Math.ceil(n / maxPts));
  const { rows } = await q(`SELECT * FROM (SELECT *, ROW_NUMBER() OVER (ORDER BY epoch) AS rn FROM readings WHERE epoch >= $1) t
    WHERE (rn - 1) % $2 = 0 ORDER BY epoch`, [since, step]);
  return Response.json(rows);
}
