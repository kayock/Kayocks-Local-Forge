import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getUserFromRequest } from '@/lib/auth-server';

export const dynamic = 'force-dynamic';

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const project = await db.project.updateMany({
    where: { id, userId: user.id },
    data: {
      ...(body.name !== undefined ? { name: String(body.name).slice(0, 120) } : {}),
      ...(body.description !== undefined ? { description: String(body.description).slice(0, 500) } : {}),
      ...(body.localPath !== undefined ? { localPath: String(body.localPath).slice(0, 500) } : {}),
      ...(body.companionLabel !== undefined ? { companionLabel: String(body.companionLabel).slice(0, 120) } : {}),
    },
  });
  return NextResponse.json({ ok: project.count > 0 });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });
  const { id } = await params;
  await db.project.deleteMany({ where: { id, userId: user.id } });
  return NextResponse.json({ ok: true });
}
