import { redirect } from 'next/navigation';
import { authEnabled, isSignedIn } from '@/lib/auth';
import Dashboard from '@/components/Dashboard';

export const dynamic = 'force-dynamic';

export default async function Home() {
  if (!(await isSignedIn())) redirect('/login');
  return <Dashboard authEnabled={authEnabled()} />;
}
