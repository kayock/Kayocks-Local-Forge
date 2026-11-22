import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { verifyPassword, createSession, sessionCookie } from '@/lib/auth-server';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const { email, password } = await req.json();
    if (!email || !password) {
      return NextResponse.json({ error: 'Email and password are required.' }, { status: 400 });
    }
    const user = await db.user.findUnique({
      where: { email: String(email).toLowerCase() },
      include: { subscription: true },
    });
    if (!user || !verifyPassword(String(password), user.passwordHash)) {
      return NextResponse.json({ error: 'Invalid email or password.' }, { status: 401 });
    }
    const { token, expiresAt } = await createSession(user.id, req.headers.get('user-agent'));
    const res = NextResponse.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        subscription: user.subscription ? { tier: user.subscription.tier, status: user.subscription.status } : null,
      },
    });
    res.cookies.set(sessionCookie(token, expiresAt));
    return res;
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Login failed' }, { status: 500 });
  }
}
