// Login. When DASHBOARD_PASSWORD is set, browsers sign in on /login and get a signed,
// HttpOnly session cookie. Scripts (predict_live.py) may send HTTP Basic credentials instead.
import crypto from 'crypto';
import { cookies } from 'next/headers';

export const DASH_USER = process.env.DASHBOARD_USER || 'admin';
const DASH_PASS = process.env.DASHBOARD_PASSWORD || '';
export const authEnabled = () => !!DASH_PASS;

export const SESSION_COOKIE = 'aquaguard_session';
export const SESSION_DAYS = 7;
// Key derived from the password: changing the password signs everyone out
const KEY = crypto.createHash('sha256').update(`aquaguard-session:${DASH_USER}:${DASH_PASS}`).digest();

const same = (a: string, b: string) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const sign = (data: string) => crypto.createHmac('sha256', KEY).update(data).digest('base64url');

export function makeSession() {
  const data = Buffer.from(JSON.stringify({ u: DASH_USER, exp: Date.now() + SESSION_DAYS * 864e5 })).toString('base64url');
  return `${data}.${sign(data)}`;
}
function validSession(token?: string | null) {
  const [data, sig] = String(token || '').split('.');
  if (!data || !sig || !same(sig, sign(data))) return false;
  try { return JSON.parse(Buffer.from(data, 'base64url').toString()).exp > Date.now(); } catch { return false; }
}
function basicOk(header: string | null) {
  const [type, value] = (header || '').split(' ');
  if (type !== 'Basic' || !value) return false;
  const text = Buffer.from(value, 'base64').toString();
  const i = text.indexOf(':');
  return i > 0 && same(text.slice(0, i), DASH_USER) && same(text.slice(i + 1), DASH_PASS);
}
export const checkCredentials = (user: string, pass: string) => same(user, DASH_USER) && same(pass, DASH_PASS);

/** For pages (server components). */
export async function isSignedIn() {
  if (!DASH_PASS) return true;
  return validSession((await cookies()).get(SESSION_COOKIE)?.value);
}

/** For route handlers: returns a 401 response when not signed in. */
export async function requireAuth(req: Request): Promise<Response | null> {
  if (!DASH_PASS || basicOk(req.headers.get('authorization')) || (await isSignedIn())) return null;
  return Response.json({ error: 'Not signed in' }, { status: 401 });
}

// Slow down password guessing: 10 failed attempts per IP per 15 minutes
const g = globalThis as unknown as { __aquaguardFails?: Map<string, { count: number; since: number }> };
const failures = (g.__aquaguardFails ??= new Map());
const WINDOW = 15 * 60e3;
export function tooManyFailures(ip: string) {
  const f = failures.get(ip);
  if (!f || Date.now() - f.since > WINDOW) { failures.delete(ip); return false; }
  return f.count >= 10;
}
export function recordFailure(ip: string) {
  const f = failures.get(ip);
  if (!f || Date.now() - f.since > WINDOW) failures.set(ip, { count: 1, since: Date.now() });
  else f.count++;
}
export const clearFailures = (ip: string) => failures.delete(ip);

export function clientIp(req: Request) {
  return (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || req.headers.get('x-real-ip') || 'local';
}
export function isHttps(req: Request) {
  return (req.headers.get('x-forwarded-proto') || new URL(req.url).protocol.replace(':', '')) === 'https';
}
