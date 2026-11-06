import { authEnabled, isSignedIn } from '@/lib/auth';

export const dynamic = 'force-dynamic';

// Untuk dapetin udh login atau blom
export async function GET() {
  return Response.json({ auth: authEnabled(), signedIn: await isSignedIn() });
}
