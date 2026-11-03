// Next.js runs this once at server start: begins MQTT ingest (skipped during `next build`)
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.NEXT_PHASE === 'phase-production-build') return;

  const { boot } = await import('./lib/ingest');
  boot();
}
