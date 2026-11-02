// MQTT ingest: runs once per server process (started from instrumentation.ts) and keeps
// receiving ESP32 data even when nobody has the dashboard open.
import mqtt from 'mqtt';
import { COLS, TEXT_COLS, insertReadingSql, logEvent, now, num, q, waitForDb } from './db';
import { TOPIC_BASE, broadcast, health, store, type Reading } from './store';

const MQTT_URL = process.env.MQTT_URL || 'mqtt://broker.hivemq.com:1883';

export async function startIngest() {
  if (store.started) return;
  store.started = true;

  await waitForDb();
  const { rows } = await q<{ value: string }>('SELECT value FROM settings WHERE key = $1', ['label']);
  store.currentLabel = rows[0]?.value || '';

  const client = mqtt.connect(MQTT_URL, {
    reconnectPeriod: 3000,
    clientId: 'aquaguard-server-' + Math.random().toString(16).slice(2, 8),
  });
  store.publish = (topic, payload) => client.publish(topic, payload);

  client.on('connect', () => {
    store.mqttUp = true;
    client.subscribe([`${TOPIC_BASE}/data`, `${TOPIC_BASE}/event`, `${TOPIC_BASE}/status`]);
    console.log(`MQTT connected to ${MQTT_URL}, topics ${TOPIC_BASE}/#`);
    broadcast('health', health());
  });
  client.on('close', () => { if (store.mqttUp) { store.mqttUp = false; broadcast('health', health()); } });
  client.on('error', (e) => console.error('MQTT error:', e.message));

  client.on('message', async (topic, buf) => {
    const sub = topic.slice(TOPIC_BASE.length + 1);
    const text = buf.toString();
    if (sub === 'status') { store.deviceStatus = text; broadcast('health', health()); return; }
    let m: Record<string, unknown>;
    try { m = JSON.parse(text); } catch { return; }
    const t = now();
    const source = m.src === 'sim' ? 'sim' : 'device';
    try {
      if (sub === 'data') {
        const vals = COLS.map((c) => (TEXT_COLS.has(c) ? (m[c] ?? null) : num(m[c])));
        const label = store.currentLabel || null;
        const res = await q<{ id: number }>(insertReadingSql, [t, num(m.ts), ...vals, label, source]);
        const reading = { id: res.rows[0].id, epoch: t, device_ts: num(m.ts), label, source } as Reading;
        COLS.forEach((c, i) => { reading[c] = vals[i] as number | string | null; });
        store.latest = reading;
        store.lastDataAt = Date.now();
        broadcast('reading', reading);
      } else if (sub === 'event') {
        const ev = { epoch: t, type: m.type ?? null, name: m.name ?? null, value: num(m.value), detail: m.detail ?? null, source };
        await logEvent(t, num(m.ts), String(ev.type), ev.name as string | null, ev.value, ev.detail as string | null, source);
        broadcast('event', ev);
      }
    } catch (e) {
      console.error('Message not saved:', (e as Error).message);
    }
  });

  setInterval(() => broadcast('health', health()), 5000);
}

/** Start ingest; stop the process if the database never becomes reachable (Docker restarts it). */
export function boot() {
  if (!process.env.DASHBOARD_PASSWORD) console.warn('DASHBOARD_PASSWORD not set: dashboard has no login (fine on localhost only)');
  startIngest().catch((e) => {
    console.error('Startup failed:', (e as Error).message);
    process.exit(1);
  });
}
