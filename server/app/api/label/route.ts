import { requireAuth } from '@/lib/auth';
import { logEvent, now, saveSetting } from '@/lib/db';
import { broadcast, health, store } from '@/lib/store';

export const dynamic = 'force-dynamic';

// Untuk set label untuk data sensor berikutnya
export async function POST(request: Request) {
  const denied = await requireAuth(request);
  if (denied) return denied;

  const body = await request.json().catch(() => ({}));
  const label = String(body.label || '').trim();
  if (label && !/^[a-z_]{1,32}$/.test(label)) {
    return Response.json({ error: 'label must be a-z or _' }, { status: 400 });
  }


  
  await saveSetting('label', label);
  store.currentLabel = label;
  logEvent(now(), null, 'label', label || '(none)', null, 'label changed on dashboard', 'server');
  broadcast('health', health());

  return Response.json({ ok: true, label });
}
