import mqtt from 'mqtt';
import { COLS, TEXT_COLS, insertReadingSql, logEvent, now, num, q, readSetting, waitForDb } from './db';
import { TOPIC_BASE, broadcast, health, store, type ServerReading } from './store';

const MQTT_URL = process.env.MQTT_URL || 'mqtt://broker.hivemq.com:1883';

async function saveReading(message: Record<string, unknown>, source: string) {
  const epoch = now();
  const values = COLS.map((column) => (TEXT_COLS.has(column) ? message[column] ?? null : num(message[column])));
  const label = store.currentLabel || null;
  // While recording is paused the reading is still shown live but not stored
  let id = 0;
  if (store.recording) {
    const result = await q<{ id: number }>(insertReadingSql, [epoch, num(message.ts), ...values, label, source]);
    id = result.rows[0].id;
  }

  const reading: ServerReading = { id, epoch, device_ts: num(message.ts), label, source, stored: store.recording ? 1 : 0 };
  COLS.forEach((column, index) => {
    reading[column] = values[index] as number | string | null;
  });

  store.latest = reading;
  store.lastDataAt = Date.now();
  broadcast('reading', reading);
}

async function saveEvent(message: Record<string, unknown>, source: string) {
  const event = {
    epoch: now(),
    type: String(message.type ?? ''),
    name: (message.name as string) ?? null,
    value: num(message.value),
    detail: (message.detail as string) ?? null,
    source,
  };
  await logEvent(event.epoch, num(message.ts), event.type, event.name, event.value, event.detail, source);
  broadcast('event', event);
}

async function startIngest() {
  if (store.started) return;
  store.started = true;

  await waitForDb();

  // Restore what the dashboard set before the restart
  store.currentLabel = (await readSetting('label')) || '';
  store.recording = (await readSetting('recording')) !== '0';   // recording is on unless turned off

  const client = mqtt.connect(MQTT_URL, {
    reconnectPeriod: 3000,
    clientId: `iot-project-server-${Math.random().toString(16).slice(2, 8)}`,
  });
  store.publish = (topic, payload) => client.publish(topic, payload);

  client.on('connect', () => {
    store.mqttUp = true;
    client.subscribe([`${TOPIC_BASE}/data`, `${TOPIC_BASE}/event`, `${TOPIC_BASE}/status`]);
    console.log(`MQTT connected to ${MQTT_URL}, topics ${TOPIC_BASE}/#`);
    broadcast('health', health());
  });

  client.on('close', () => {
    if (!store.mqttUp) return;
    store.mqttUp = false;
    broadcast('health', health());
  });

  client.on('error', (error) => console.error('MQTT error:', error.message));

  client.on('message', async (topic, payload) => {
    const subtopic = topic.slice(TOPIC_BASE.length + 1);
    const text = payload.toString();

    if (subtopic === 'status') {
      store.deviceStatus = text;
      broadcast('health', health());
      return;
    }

    let message: Record<string, unknown>;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }

    const source = message.src === 'sim' ? 'sim' : 'device';
    try {
      if (subtopic === 'data') await saveReading(message, source);
      if (subtopic === 'event') await saveEvent(message, source);
    } catch (error) {
      console.error('Message not saved:', (error as Error).message);
    }
  });

  setInterval(() => broadcast('health', health()), 5000);
}

export function boot() {
  if (!process.env.DASHBOARD_PASSWORD) {
    console.warn('DASHBOARD_PASSWORD is not set, so the dashboard has no login. Only do this on localhost.');
  }
  startIngest().catch((error) => {
    console.error('Startup failed:', (error as Error).message);
    process.exit(1);
  });
}
