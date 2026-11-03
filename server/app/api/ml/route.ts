import { requireAuth } from '@/lib/auth';
import { now } from '@/lib/db';
import { broadcast, store } from '@/lib/store';

export const dynamic = 'force-dynamic';

// Receives a prediction from ml/predict_live.py and shows it live on the dashboards
export async function POST(request: Request) {
  const denied = await requireAuth(request);
  if (denied) return denied;

  const body = await request.json().catch(() => ({}));
  store.latestMl = { ...body, epoch: now() };
  broadcast('ml', store.latestMl);
  return Response.json({ ok: true });
}
