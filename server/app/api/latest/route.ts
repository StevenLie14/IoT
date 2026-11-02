import { requireAuth } from '@/lib/auth';
import { health, store } from '@/lib/store';
export const dynamic = 'force-dynamic';
export async function GET(req: Request) {
  const denied = await requireAuth(req); if (denied) return denied;
  return Response.json({ reading: store.latest, ml: store.latestMl, health: health() });
}
