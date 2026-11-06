export type ServerReading = Record<string, number | string | null> & { id: number; epoch: number; source: string };

// Function yg dipanggil untuk kirim ke browser lewat SSE
type Listener = (event: string, data: unknown) => void;

type Store = {
  latest: ServerReading | null
  deviceStatus: string
  mqttConnected: boolean
  lastDataAt: number
  currentLabel: string
  recording: boolean
  listeners: Set<Listener>
  started: boolean
  publish?: (topic: string, payload: string) => void
};

const globalForStore = globalThis as unknown as { iotProjectStore?: Store };

if (!globalForStore.iotProjectStore) {
  globalForStore.iotProjectStore = {
    latest: null,
    deviceStatus: 'unknown',
    mqttConnected: false,
    lastDataAt: 0,
    currentLabel: '',
    recording: true,
    listeners: new Set(),
    started: false,
  };
}

export const store = globalForStore.iotProjectStore;

// Topic yg di subscribe
export const TOPIC_BASE = process.env.TOPIC_BASE || 'iot-project/steven-2802941592';

// Health MQTT, device dkk yg ditampilin di UI
export function health() {
  return {
    mqtt: store.mqttConnected,
    device: store.deviceStatus,
    dataFresh: Date.now() - store.lastDataAt < 15000,
    label: store.currentLabel,
    recording: store.recording,
    topic: TOPIC_BASE,
  };
}

export function broadcast(event: string, data: unknown) {
  for (const listener of store.listeners) listener(event, data);
}
