'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function LoginForm() {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (!username.trim() || !password) { setError('Enter your username and password.'); return; }
    setBusy(true);
    try {
      const res = await fetch('/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      if (res.ok) { router.replace('/'); router.refresh(); return; }
      const body = await res.json().catch(() => ({}));
      setError(body.error || 'Sign in failed.');
      setPassword('');
    } catch {
      setError('Cannot reach the server. Check your connection.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate>
      <div className={'error' + (error ? ' show' : '')} role="alert">{error}</div>
      <div className="field">
        <label htmlFor="username">Username</label>
        <input id="username" autoComplete="username" autoFocus value={username} onChange={(e) => setUsername(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="password">Password</label>
        <input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </div>
      <button className="btn primary" type="submit" disabled={busy}>{busy ? 'Signing in' : 'Sign in'}</button>
    </form>
  );
}
