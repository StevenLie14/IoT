import { requireAuth } from '@/lib/auth';
import { logEvent, now, q } from '@/lib/db';
import { broadcast, health, store } from '@/lib/store';
export const dynamic = 'force-dynamic';

// Pauses or resumes storing readings. Live data keeps flowing to the dashboard either way.
export async function POST(req: Request) {
  const denied = await requireAuth(req); if (denied) return denied;
  const on = Boolean((await req.json().catch(() => ({}))).on);
  await q('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', ['recording', on ? '1' : '0']);
  store.recording = on;
  logEvent(now(), null, 'recording', on ? 'on' : 'off', null, on ? 'readings are stored again' : 'readings are not stored', 'server');
  broadcast('health', health());
  return Response.json({ ok: true, recording: on });
}
