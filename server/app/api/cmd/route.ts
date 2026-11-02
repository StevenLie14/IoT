import { requireAuth } from '@/lib/auth';
import { logEvent, now, num } from '@/lib/db';
import { TOPIC_BASE, store } from '@/lib/store';
export const dynamic = 'force-dynamic';
const ALLOWED = ['change', 'stop', 'reset', 'auto', 'demo', 'beep', 'drain', 'fill'];
export async function POST(req: Request) {
  const denied = await requireAuth(req); if (denied) return denied;
  const body = await req.json().catch(() => ({}));
  if (!ALLOWED.includes(body.cmd)) return Response.json({ error: 'unknown cmd' }, { status: 400 });
  if (!store.mqttUp || !store.publish) return Response.json({ error: 'MQTT not connected' }, { status: 503 });
  store.publish(`${TOPIC_BASE}/cmd`, JSON.stringify(body));
  const value = num(body.pct ?? body.sec ?? (body.on === undefined ? null : body.on ? 1 : 0));
  logEvent(now(), null, 'command', body.cmd, value, 'from dashboard', 'server');
  return Response.json({ ok: true });
}
