// The laptop ML script (predict_live.py) posts its live prediction here
import { requireAuth } from '@/lib/auth';
import { now } from '@/lib/db';
import { broadcast, store } from '@/lib/store';
export const dynamic = 'force-dynamic';
export async function POST(req: Request) {
  const denied = await requireAuth(req); if (denied) return denied;
  store.latestMl = { ...(await req.json().catch(() => ({}))), epoch: now() };
  broadcast('ml', store.latestMl);
  return Response.json({ ok: true });
}
