// Process-wide state shared by the MQTT ingest (started from instrumentation.ts)
// and the route handlers. Next.js may load these modules in separate bundles,
// so the state lives on globalThis instead of in module variables.

export type Reading = Record<string, number | string | null> & { id: number; epoch: number; source: string };
export type MlPrediction = { prediction: string; confidence?: number | null; model?: string; epoch: number };
type Listener = (event: string, data: unknown) => void;

type Store = {
  latest: Reading | null;
  latestMl: MlPrediction | null;
  deviceStatus: string;
  mqttUp: boolean;
  lastDataAt: number;
  currentLabel: string;
  listeners: Set<Listener>;
  started: boolean;
  publish?: (topic: string, payload: string) => void;
};

const g = globalThis as unknown as { __aquaguard?: Store };
export const store: Store = (g.__aquaguard ??= {
  latest: null,
  latestMl: null,
  deviceStatus: 'unknown',
  mqttUp: false,
  lastDataAt: 0,
  currentLabel: '',
  listeners: new Set(),
  started: false,
});

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
  for (const l of store.listeners) l(event, data);
}
