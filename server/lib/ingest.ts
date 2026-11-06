import mqtt from 'mqtt';
import {
  READING_COLUMNS,
  TEXT_COLUMNS,
  insertReadingSql,
  logEvent,
  now,
  query,
  readSetting,
  toNumber,
  waitForDatabase,
} from './db';
import { TOPIC_BASE, broadcast, health, store, type ServerReading } from './store';

const MQTT_URL = process.env.MQTT_URL || 'mqtt://broker.hivemq.com:1883';

// Buat simpan data sensor dari MQTT topic data ke readings dan dashboard
async function saveReading(message: Record<string, unknown>, source: string) {
  const epoch = now();
  const values = READING_COLUMNS.map((column) =>
    TEXT_COLUMNS.has(column) ? message[column] ?? null : toNumber(message[column]),
  );
  const label = store.currentLabel || null;

  let id = 0;
  if (store.recording) {
    const result = await query<{ id: number }>(insertReadingSql, [epoch, toNumber(message.ts), ...values, label, source]);
    id = result.rows[0].id;
  }

  const reading: ServerReading = {
    id,
    epoch,
    device_ts: toNumber(message.ts),
    label,
    source,
    stored: store.recording ? 1 : 0,
  };
  READING_COLUMNS.forEach((column, index) => {
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
    value: toNumber(message.value),
    detail: (message.detail as string) ?? null,
    source,
  };
  await logEvent(event.epoch, toNumber(message.ts), event.type, event.name, event.value, event.detail, source);
  broadcast('event', event);
}

async function startIngest() {
  if (store.started) return;
  store.started = true;

  await waitForDatabase();

  store.currentLabel = (await readSetting('label')) || '';
  store.recording = (await readSetting('recording')) !== '0';

  // Connect ke MQTT
  const client = mqtt.connect(MQTT_URL, {
    reconnectPeriod: 3000,
    clientId: `iot-project-server-${Math.random().toString(16).slice(2, 8)}`,
  });
  store.publish = (topic, payload) => client.publish(topic, payload);

  client.on('connect', () => {
    store.mqttConnected = true;
    client.subscribe([`${TOPIC_BASE}/data`, `${TOPIC_BASE}/event`, `${TOPIC_BASE}/status`]);
    console.log(`MQTT connected to ${MQTT_URL}, topics ${TOPIC_BASE}/#`);
    broadcast('health', health());
  });

  client.on('close', () => {
    if (!store.mqttConnected) return;
    store.mqttConnected = false;
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

    try {
      if (subtopic === 'data') await saveReading(message, 'device');
      if (subtopic === 'event') await saveEvent(message, 'device');
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
