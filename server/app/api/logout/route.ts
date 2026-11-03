import { cookies } from 'next/headers';
import { SESSION_COOKIE } from '@/lib/auth';

export const dynamic = 'force-dynamic';

// Signs out by deleting the session cookie
export async function POST() {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE);
  return Response.json({ ok: true });
}
