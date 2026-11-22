// Server-side auth helpers: scrypt password hashing and opaque session tokens.
// Zero external dependencies (node:crypto only).
import { db } from '@/lib/db';
import { NextRequest } from 'next/server';
import crypto from 'node:crypto';

const SESSION_COOKIE = 'lf_session';
const SESSION_DAYS = 30;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, hash] = parts;
  const candidate = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(candidate, 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

export function passwordProblems(password: string): string | null {
  if (password.length < 8) return 'Password must be at least 8 characters.';
  return null;
}

export async function createSession(userId: string, userAgent?: string | null): Promise<{ token: string; expiresAt: Date }> {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400_000);
  await db.session.create({
    data: { userId, tokenHash, userAgent: userAgent?.slice(0, 200) || null, expiresAt },
  });
  return { token, expiresAt };
}

export function sessionCookie(token: string, expiresAt: Date) {
  return {
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    expires: expiresAt,
  };
}

export function clearedSessionCookie() {
  return {
    name: SESSION_COOKIE,
    value: '',
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 0,
  };
}

export async function getUserFromRequest(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const session = await db.session.findUnique({ where: { tokenHash } });
  if (!session || session.expiresAt < new Date()) return null;
  const user = await db.user.findUnique({
    where: { id: session.userId },
    include: { subscription: true },
  });
  return user;
}

export function publicUser(user: {
  id: string; email: string; name: string; role: string;
  subscription?: { tier: string; status: string } | null;
}) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    subscription: user.subscription ? { tier: user.subscription.tier, status: user.subscription.status } : null,
  };
}
