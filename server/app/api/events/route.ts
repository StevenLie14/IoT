import { requireAuth } from '@/lib/auth';
import { q } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const denied = await requireAuth(request);
  if (denied) return denied;

  const requested = Number(new URL(request.url).searchParams.get('limit')) || 50;
  const limit = Math.min(requested, 500);
  const result = await q('SELECT * FROM events ORDER BY id DESC LIMIT $1', [limit]);
  return Response.json(result.rows);
}
