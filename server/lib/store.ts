export type ServerReading = Record<string, number | string | null> & { id: number; epoch: number; source: string };
export type LaptopPrediction = { prediction: string; confidence?: number | null; model?: string; epoch: number };
type Listener = (event: string, data: unknown) => void;

type Store = {
  latest: ServerReading | null;
  latestMl: LaptopPrediction | null;
  deviceStatus: string;
  mqttUp: boolean;
  lastDataAt: number;
  currentLabel: string;
  recording: boolean;
  listeners: Set<Listener>;
  started: boolean;
  publish?: (topic: string, payload: string) => void;
};

const globalForStore = globalThis as unknown as { iotProjectStore?: Store };

if (!globalForStore.iotProjectStore) {
  globalForStore.iotProjectStore = {
    latest: null,
    latestMl: null,
    deviceStatus: 'unknown',
    mqttUp: false,
    lastDataAt: 0,
    currentLabel: '',
    recording: true,
    listeners: new Set(),
    started: false,
  };
}

export const store = globalForStore.iotProjectStore;

export const TOPIC_BASE = process.env.TOPIC_BASE || 'iot-project/steven-2802941592';

export function health() {
  return {
    mqtt: store.mqttUp,
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
