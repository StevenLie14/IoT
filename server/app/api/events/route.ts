import { requireAuth } from '@/lib/auth';
import { q } from '@/lib/db';
export const dynamic = 'force-dynamic';
// Most recent events for the event log (?limit=, max 500)
export async function GET(req: Request) {
  const denied = await requireAuth(req); if (denied) return denied;
  const limit = Math.min(Number(new URL(req.url).searchParams.get('limit')) || 50, 500);
  return Response.json((await q('SELECT * FROM events ORDER BY id DESC LIMIT $1', [limit])).rows);
}
