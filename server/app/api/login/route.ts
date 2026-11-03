import { cookies } from 'next/headers';
import {
  SESSION_COOKIE,
  SESSION_DAYS,
  authEnabled,
  checkCredentials,
  clearFailedLogins,
  clientIp,
  isHttps,
  isLockedOut,
  makeSession,
  recordFailedLogin,
} from '@/lib/auth';

export const dynamic = 'force-dynamic';

// Checks the login form and sets the session cookie; too many failures lock the IP out
export async function POST(request: Request) {
  if (!authEnabled()) return Response.json({ ok: true });

  const ip = clientIp(request);
  if (isLockedOut(ip)) {
    return Response.json({ error: 'Too many attempts. Try again in 15 minutes.' }, { status: 429 });
  }

  const body = await request.json().catch(() => ({}));
  const username = String(body.username ?? '');
  const password = String(body.password ?? '');

  if (!checkCredentials(username, password)) {
    recordFailedLogin(ip);
    return Response.json({ error: 'Wrong username or password.' }, { status: 401 });
  }

  clearFailedLogins(ip);
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, makeSession(), {
    httpOnly: true,
    sameSite: 'lax',
    secure: isHttps(request),
    maxAge: SESSION_DAYS * 24 * 60 * 60,
    path: '/',
  });

  return Response.json({ ok: true });
}
