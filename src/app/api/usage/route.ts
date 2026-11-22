import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getUserFromRequest } from '@/lib/auth-server';

export const dynamic = 'force-dynamic';

// Usage analytics for HOSTED services only (e.g. agent_run counts, ide
// sessions). Never logs inference tokens — inference runs on the customer's
// own hardware and never touches our servers.
export async function POST(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ ok: false }, { status: 200 }); // anonymous: skip silently
  const { kind, meta } = await req.json().catch(() => ({}));
  if (typeof kind !== 'string' || kind.length > 64) {
    return NextResponse.json({ error: 'Invalid usage kind.' }, { status: 400 });
  }
  await db.usageEvent.create({
    data: {
      userId: user.id,
      kind,
      metaJson: meta ? JSON.stringify(meta).slice(0, 2000) : null,
    },
  });
  return NextResponse.json({ ok: true });
}

export async function GET(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });
  const events = await db.usageEvent.groupBy({
    by: ['kind'],
    where: { userId: user.id },
    _count: { kind: true },
    _max: { createdAt: true },
  });
  return NextResponse.json({
    events: events.map((e) => ({
      kind: e.kind,
      count: e._count.kind,
      lastAt: e._max.createdAt?.toISOString() || '',
    })),
  });
}
