import { requireAuth } from '@/lib/auth';
import { logEvent, now, toNumber } from '@/lib/db';
import { TOPIC_BASE, store } from '@/lib/store';

export const dynamic = 'force-dynamic';


// List Command yg bisa dikirim ke ESP32
const ALLOWED_COMMANDS = ['change', 'stop', 'auto', 'beep', 'drain', 'fill', 'drain_float', 'fill_float'];

export async function POST(request: Request) {
  const denied = await requireAuth(request);
  if (denied) return denied;

  const body = await request.json().catch(() => ({}));
  if (!ALLOWED_COMMANDS.includes(body.cmd)) {
    return Response.json({ error: 'unknown cmd' }, { status: 400 });
  }
  
  if (!store.mqttConnected || !store.publish) {
    return Response.json({ error: 'MQTT not connected' }, { status: 503 });
  }



  store.publish(`${TOPIC_BASE}/cmd`, JSON.stringify(body));

  let value: number | null = null;
  if (body.sec !== undefined) value = toNumber(body.sec);
  else if (body.on !== undefined) value = body.on ? 1 : 0;
  logEvent(now(), null, 'command', body.cmd, value, 'from dashboard', 'server');

  return Response.json({ ok: true });
}
