import { requireAuth } from '@/lib/auth';
import { logEvent, now, q } from '@/lib/db';
import { broadcast, health, store } from '@/lib/store';
export const dynamic = 'force-dynamic';
// Sets the label attached to new readings ("" = no label) and remembers it across restarts
export async function POST(req: Request) {
  const denied = await requireAuth(req); if (denied) return denied;
  const label = String((await req.json().catch(() => ({}))).label || '').trim();
  if (label && !/^[a-z_]{1,32}$/.test(label)) return Response.json({ error: 'label must be a-z or _' }, { status: 400 });
  await q('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', ['label', label]);
  store.currentLabel = label;
  logEvent(now(), null, 'label', label || '(none)', null, 'label changed on dashboard', 'server');
  broadcast('health', health());
  return Response.json({ ok: true, label });
}
