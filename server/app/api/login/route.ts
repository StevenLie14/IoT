import { cookies } from 'next/headers';
import { SESSION_COOKIE, SESSION_DAYS, authEnabled, checkCredentials, clearFailures, clientIp, isHttps,
  makeSession, recordFailure, tooManyFailures } from '@/lib/auth';
export const dynamic = 'force-dynamic';
export async function POST(req: Request) {
  if (!authEnabled()) return Response.json({ ok: true });
  const ip = clientIp(req);
  if (tooManyFailures(ip)) return Response.json({ error: 'Too many attempts. Try again in 15 minutes.' }, { status: 429 });
  const { username = '', password = '' } = await req.json().catch(() => ({}));
  if (!checkCredentials(String(username), String(password))) {
    recordFailure(ip);
    return Response.json({ error: 'Wrong username or password.' }, { status: 401 });
  }
  clearFailures(ip);
  (await cookies()).set(SESSION_COOKIE, makeSession(), {
    httpOnly: true, sameSite: 'lax', secure: isHttps(req), maxAge: SESSION_DAYS * 86400, path: '/',
  });
  return Response.json({ ok: true });
}
