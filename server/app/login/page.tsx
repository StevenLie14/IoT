import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { authEnabled, isSignedIn } from '@/lib/auth';
import LoginForm from '@/components/LoginForm';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Sign in · IoT Project' };

export default async function LoginPage() {
  if (!authEnabled() || (await isSignedIn())) redirect('/');
  return (
    <main className="login-page">
      <div className="login">
        <div className="brand">IoT Project <small>Tank 01</small></div>
        <div className="panel"><LoginForm /></div>
        <footer>Water-quality monitoring and automatic water change</footer>
      </div>
    </main>
  );
}
