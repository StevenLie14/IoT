// Thrown after a 401 so callers can skip their own error message (the page is already going to /login)
export class SignedOutError extends Error {}

// fetch wrapper for the dashboard: sends JSON, redirects to /login on 401, throws the server's error message
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });

  if (response.status === 401) {
    window.location.href = '/login';
    throw new SignedOutError('Signed out');
  }

  const isJson = response.headers.get('content-type')?.includes('json');
  const body = isJson ? await response.json() : null;
  if (!response.ok) throw new Error(body?.error || response.statusText);
  return body as T;
}

// POST a JSON body to an API route
export function post<T = { ok: boolean }>(path: string, body: unknown) {
  return api<T>(path, { method: 'POST', body: JSON.stringify(body) });
}
