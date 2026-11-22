import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getUserFromRequest } from '@/lib/auth-server';

export const dynamic = 'force-dynamic';

// Project METADATA only — never file contents. Projects' actual files live on
// the customer's machine, accessed through the local companion.
export async function GET(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });
  const projects = await db.project.findMany({
    where: { userId: user.id },
    orderBy: { lastOpenedAt: 'desc' },
  });
  return NextResponse.json({ projects });
}

export async function POST(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const project = await db.project.create({
    data: {
      userId: user.id,
      name: String(body.name || 'Untitled project').slice(0, 120),
      description: body.description ? String(body.description).slice(0, 500) : null,
      localPath: body.localPath ? String(body.localPath).slice(0, 500) : null,
      companionLabel: body.companionLabel ? String(body.companionLabel).slice(0, 120) : null,
    },
  });
  return NextResponse.json({ project });
}
