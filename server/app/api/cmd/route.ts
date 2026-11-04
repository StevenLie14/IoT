import { requireAuth } from '@/lib/auth';
import { logEvent, now, num } from '@/lib/db';
import { TOPIC_BASE, store } from '@/lib/store';

export const dynamic = 'force-dynamic';

const ALLOWED = ['change', 'stop', 'auto', 'beep', 'drain', 'fill', 'drain_float', 'fill_float'];

// Forwards a dashboard command to the ESP32 over MQTT (only commands in ALLOWED) and logs it
export async function POST(request: Request) {
  const denied = await requireAuth(request);
  if (denied) return denied;

  const body = await request.json().catch(() => ({}));
  if (!ALLOWED.includes(body.cmd)) {
    return Response.json({ error: 'unknown cmd' }, { status: 400 });
  }
  if (!store.mqttUp || !store.publish) {
    return Response.json({ error: 'MQTT not connected' }, { status: 503 });
  }

  store.publish(`${TOPIC_BASE}/cmd`, JSON.stringify(body));

  // Log the command's argument too: seconds for a pump test, 1/0 for a mode switch
  let value: number | null = null;
  if (body.sec !== undefined) value = num(body.sec);
  else if (body.on !== undefined) value = body.on ? 1 : 0;
  logEvent(now(), null, 'command', body.cmd, value, 'from dashboard', 'server');

  return Response.json({ ok: true });
}
