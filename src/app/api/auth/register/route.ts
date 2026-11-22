import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { hashPassword, verifyPassword, isValidEmail, passwordProblems, createSession, sessionCookie } from '@/lib/auth-server';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const { email, password, name } = await req.json();
    if (!email || !password || !name) {
      return NextResponse.json({ error: 'Email, password and name are required.' }, { status: 400 });
    }
    if (!isValidEmail(String(email))) {
      return NextResponse.json({ error: 'Please enter a valid email address.' }, { status: 400 });
    }
    const pwProblem = passwordProblems(String(password));
    if (pwProblem) return NextResponse.json({ error: pwProblem }, { status: 400 });

    const existing = await db.user.findUnique({ where: { email: String(email).toLowerCase() } });
    if (existing) {
      return NextResponse.json({ error: 'An account with this email already exists. Try logging in.' }, { status: 409 });
    }

    const user = await db.user.create({
      data: {
        email: String(email).toLowerCase(),
        passwordHash: hashPassword(String(password)),
        name: String(name).slice(0, 100),
        subscription: { create: { tier: 'free', status: 'active' } },
      },
      include: { subscription: true },
    });

    const { token, expiresAt } = await createSession(user.id, req.headers.get('user-agent'));
    const res = NextResponse.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        subscription: { tier: user.subscription?.tier ?? 'free', status: user.subscription?.status ?? 'active' },
      },
    });
    res.cookies.set(sessionCookie(token, expiresAt));
    return res;
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Registration failed' }, { status: 500 });
  }
}
