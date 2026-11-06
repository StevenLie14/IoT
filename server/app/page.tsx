import { redirect } from 'next/navigation';
import { authEnabled, isSignedIn } from '@/lib/auth';
import Dashboard from '@/components/dashboard/Dashboard';

export const dynamic = 'force-dynamic';

// Halaman utama, kalau belum login pindah ke /login
export default async function Home() {
  if (!(await isSignedIn())) redirect('/login');
  return <Dashboard authEnabled={authEnabled()} />;
}
