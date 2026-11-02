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
  listeners: Set<Listener>;
  started: boolean;
  publish?: (topic: string, payload: string) => void;
};

const globalForStore = globalThis as unknown as { aquaguardStore?: Store };

if (!globalForStore.aquaguardStore) {
  globalForStore.aquaguardStore = {
    latest: null,
    latestMl: null,
    deviceStatus: 'unknown',
    mqttUp: false,
    lastDataAt: 0,
    currentLabel: '',
    listeners: new Set(),
    started: false,
  };
}

export const store = globalForStore.aquaguardStore;

export const TOPIC_BASE = process.env.TOPIC_BASE || 'aquaguard/steven-2802941592';

export function health() {
  return {
    mqtt: store.mqttUp,
    device: store.deviceStatus,
    dataFresh: Date.now() - store.lastDataAt < 15000,
    label: store.currentLabel,
    topic: TOPIC_BASE,
  };
}

export function broadcast(event: string, data: unknown) {
  for (const listener of store.listeners) listener(event, data);
}
