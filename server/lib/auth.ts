import crypto from 'crypto';
import { cookies } from 'next/headers';


// Buat auth

const USERNAME = process.env.DASHBOARD_USER || 'admin';
const PASSWORD = process.env.DASHBOARD_PASSWORD || '';

export const SESSION_COOKIE = 'iot_project_session';
export const SESSION_DAYS = 7;

const sessionKey = crypto.createHash('sha256').update(`iot-project-session:${USERNAME}:${PASSWORD}`).digest();

export function authEnabled() {
  return PASSWORD !== '';
}

function sameText(first: string, second: string) {
  const left = Buffer.from(String(first));
  const right = Buffer.from(String(second));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function sign(data: string) {
  return crypto.createHmac('sha256', sessionKey).update(data).digest('base64url');
}

export function makeSession() {
  const payload = { user: USERNAME, expires: Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000 };
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${data}.${sign(data)}`;
}

// Cek session cookie valid ga
function isValidSession(token: string | undefined) {
  if (!token) return false;
  const [data, signature] = token.split('.');
  if (!data || !signature || !sameText(signature, sign(data))) return false;

  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString());
    return payload.expires > Date.now();
  } catch {
    return false;
  }
}

function hasValidBasicAuth(header: string | null) {
  if (!header?.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString(); // "username:password"
  const separator = decoded.indexOf(':');
  if (separator < 1) return false;
  return sameText(decoded.slice(0, separator), USERNAME) && sameText(decoded.slice(separator + 1), PASSWORD);
}

export function checkCredentials(username: string, password: string) {
  return sameText(username, USERNAME) && sameText(password, PASSWORD);
}

export async function isSignedIn() {
  if (!authEnabled()) return true;
  const cookieStore = await cookies();
  return isValidSession(cookieStore.get(SESSION_COOKIE)?.value);
}

// Buat cek tiap api, udh login / blom
export async function requireAuth(request: Request) {
  if (!authEnabled()) return null;
  if (hasValidBasicAuth(request.headers.get('authorization'))) return null;
  if (await isSignedIn()) return null;
  return Response.json({ error: 'Not signed in' }, { status: 401 });
}

// Rate limit
type Attempts = { count: number; since: number };

const MAX_ATTEMPTS = 10;
const LOCK_WINDOW_MS = 15 * 60 * 1000;
const globalForAuth = globalThis as unknown as { iotProjectAttempts?: Map<string, Attempts> };
const failedAttempts = globalForAuth.iotProjectAttempts ?? new Map<string, Attempts>();
globalForAuth.iotProjectAttempts = failedAttempts;

function currentAttempts(ipAddress: string) {
  const attempts = failedAttempts.get(ipAddress);
  if (attempts && Date.now() - attempts.since > LOCK_WINDOW_MS) {
    failedAttempts.delete(ipAddress);
    return undefined;
  }
  return attempts;
}

export function isLockedOut(ipAddress: string) {
  return (currentAttempts(ipAddress)?.count ?? 0) >= MAX_ATTEMPTS;
}

export function recordFailedLogin(ipAddress: string) {
  const attempts = currentAttempts(ipAddress);
  if (attempts) attempts.count += 1;
  else failedAttempts.set(ipAddress, { count: 1, since: Date.now() });
}

export function clearFailedLogins(ipAddress: string) {
  failedAttempts.delete(ipAddress);
}

export function clientIp(request: Request) {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0].trim();
  return forwarded || request.headers.get('x-real-ip') || 'local';
}

export function isHttps(request: Request) {
  const forwardedProtocol = request.headers.get('x-forwarded-proto');
  if (forwardedProtocol) return forwardedProtocol === 'https';
  return new URL(request.url).protocol === 'https:';
}
