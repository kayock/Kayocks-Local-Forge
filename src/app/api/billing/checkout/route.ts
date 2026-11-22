import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/auth-server';
import { billingEnabled } from '../tiers/route';
import { TIERS } from '../tiers/route';

export const dynamic = 'force-dynamic';

// Stripe checkout — intentionally INERT unless SUBSCRIPTIONS_ENABLED=true and
// STRIPE_SECRET_KEY is configured. The prototype never activates payments.
export async function POST(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });

  if (!billingEnabled()) {
    return NextResponse.json(
      {
        message:
          'Billing is disabled in this prototype build. Checkout will create a Stripe Checkout session when SUBSCRIPTIONS_ENABLED=true and STRIPE_SECRET_KEY are configured. No payment was attempted now.',
      },
      { status: 503 }
    );
  }

  const { tier } = await req.json().catch(() => ({}));
  const t = TIERS.find((x) => x.id === tier && x.id !== 'free');
  if (!t) return NextResponse.json({ error: 'Unknown tier.' }, { status: 400 });

  // Live path (only when billing is enabled): create a Stripe Checkout Session
  // via the REST API, no SDK needed.
  const priceId = tier === 'pro' ? process.env.STRIPE_PRICE_PRO : process.env.STRIPE_PRICE_TEAM;
  if (!priceId) return NextResponse.json({ error: 'Stripe price for this tier is not configured.' }, { status: 500 });

  const body = new URLSearchParams({
    mode: 'subscription',
    'line_items[0][price]': priceId,
    'line_items[0][quantity]': '1',
    customer_email: user.email,
    client_reference_id: user.id,
    success_url: `${process.env.NEXT_PUBLIC_APP_URL || ''}/#/dashboard`,
    cancel_url: `${process.env.NEXT_PUBLIC_APP_URL || ''}/#/dashboard`,
  });
  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  const json = await res.json();
  if (!res.ok) return NextResponse.json({ error: json?.error?.message || 'Stripe error' }, { status: 502 });
  return NextResponse.json({ url: json.url, message: 'Redirecting to Stripe Checkout…' });
}
