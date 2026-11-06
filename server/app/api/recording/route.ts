import { requireAuth } from '@/lib/auth';
import { logEvent, now, saveSetting } from '@/lib/db';
import { broadcast, health, store } from '@/lib/store';

export const dynamic = 'force-dynamic';

// Buat set apakah data sensor disimpan atau tidak (Buat testing)
export async function POST(request: Request) {
  const denied = await requireAuth(request);
  if (denied) return denied;

  const body = await request.json().catch(() => ({}));
  const on = Boolean(body.on);

  await saveSetting('recording', on ? '1' : '0');
  store.recording = on;
  const detail = on ? 'readings are stored again' : 'readings are not stored';
  logEvent(now(), null, 'recording', on ? 'on' : 'off', null, detail, 'server');
  broadcast('health', health());

  return Response.json({ ok: true, recording: on });
}
