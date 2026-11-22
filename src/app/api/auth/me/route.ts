import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest, publicUser } from '@/lib/auth-server';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const user = await getUserFromRequest(req);
  return NextResponse.json({ user: user ? publicUser(user) : null });
}
