import { authEnabled, isSignedIn } from '@/lib/auth';
export const dynamic = 'force-dynamic';
export async function GET() {
  return Response.json({ auth: authEnabled(), signedIn: await isSignedIn() });
}
