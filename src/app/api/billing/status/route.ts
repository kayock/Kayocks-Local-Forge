import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/auth-server';
import { billingEnabled } from '../tiers/route';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) {
    return NextResponse.json({ enabled: billingEnabled(), tier: 'anonymous', status: 'none' });
  }
  return NextResponse.json({
    enabled: billingEnabled(),
    tier: user.subscription?.tier ?? 'free',
    status: user.subscription?.status ?? 'active',
    message: billingEnabled()
      ? undefined
      : 'Billing is disabled in this prototype build. No payments are processed; your account is on the Free tier.',
  });
}
