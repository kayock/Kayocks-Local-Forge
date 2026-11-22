import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { clearedSessionCookie } from '@/lib/auth-server';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const token = req.cookies.get('lf_session')?.value;
  if (token) {
    const tokenHash = (await import('node:crypto')).createHash('sha256').update(token).digest('hex');
    await db.session.deleteMany({ where: { tokenHash } });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(clearedSessionCookie());
  return res;
}
