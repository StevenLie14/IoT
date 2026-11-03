import { authEnabled, isSignedIn } from '@/lib/auth';
export const dynamic = 'force-dynamic';
// Tells the login page whether login is on and whether this browser is signed in
export async function GET() {
  return Response.json({ auth: authEnabled(), signedIn: await isSignedIn() });
}
