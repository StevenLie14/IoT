import { requireAuth } from '@/lib/auth';
import { logEvent, now, q } from '@/lib/db';
import { broadcast, store } from '@/lib/store';

export const dynamic = 'force-dynamic';

// Settings (the current label) are kept
export async function POST(request: Request) {
  const denied = await requireAuth(request);
  if (denied) return denied;

  // The body must say {"confirm":"RESET"}, so a stray request cannot wipe the data
  const body = await request.json().catch(() => ({}));
  if (body.confirm !== 'RESET') {
    return Response.json({ error: 'send {"confirm":"RESET"} to delete all data' }, { status: 400 });
  }

  const countResult = await q<{ readings: number; events: number }>(
    'SELECT (SELECT COUNT(*) FROM readings) AS readings, (SELECT COUNT(*) FROM events) AS events',
  );
  const counts = countResult.rows[0];

  await q('TRUNCATE readings, events RESTART IDENTITY');
  store.latest = null;

  const detail = `deleted ${counts.readings} readings and ${counts.events} events`;
  await logEvent(now(), null, 'system', 'reset', counts.readings, detail, 'server');
  broadcast('reset', { epoch: now() });

  return Response.json({ ok: true, ...counts });
}
