// Runs once when the Next.js server starts: connect to PostgreSQL and MQTT.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.NEXT_PHASE === 'phase-production-build') return;   // nothing to connect during `next build`
  const { boot } = await import('./lib/ingest');
  boot();
}
