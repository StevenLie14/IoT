import { requireAuth } from '@/lib/auth';
import { health, store } from '@/lib/store';
export const dynamic = 'force-dynamic';
// Current state for a freshly opened dashboard: latest reading, laptop prediction, health
export async function GET(req: Request) {
  const denied = await requireAuth(req); if (denied) return denied;
  return Response.json({ reading: store.latest, ml: store.latestMl, health: health() });
}
