import { requireAuth } from '@/lib/auth';
import { now, query } from '@/lib/db';

export const dynamic = 'force-dynamic';

const MAX_POINTS = 1500;
const MAX_MINUTES = 60 * 24 * 30;


// Buat dapetin sensor data in range time untuk tampilan chart history
export async function GET(request: Request) {
  const denied = await requireAuth(request);
  if (denied) return denied;

  const requested = Number(new URL(request.url).searchParams.get('minutes')) || 30;
  const minutes = Math.min(Math.max(requested, 1), MAX_MINUTES);
  const since = now() - minutes * 60;

  const countResult = await query<{ total: number }>('SELECT COUNT(*) AS total FROM readings WHERE epoch >= $1', [since]);
  const step = Math.max(1, Math.ceil(countResult.rows[0].total / MAX_POINTS));

  const result = await query('SELECT * FROM (SELECT *, ROW_NUMBER() OVER (ORDER BY epoch) AS row_index FROM readings WHERE epoch >= $1) numbered WHERE (row_index - 1) % $2 = 0 ORDER BY epoch', [since, step]);
  return Response.json(result.rows);
}
