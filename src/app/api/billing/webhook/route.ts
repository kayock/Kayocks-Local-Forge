import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import crypto from 'node:crypto';

export const dynamic = 'force-dynamic';

// Stripe webhook receiver. Validates the signature when STRIPE_WEBHOOK_SECRET
// is set, stores raw events, and updates local subscription rows.
// Inert in the prototype (billing disabled) but fully wired for activation.
export async function POST(req: NextRequest) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const raw = await req.text();
  const sig = req.headers.get('stripe-signature');

  let event: any;
  if (secret && sig) {
    const ok = verifyStripeSignature(raw, sig, secret);
    if (!ok) return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
    event = JSON.parse(raw);
  } else {
    event = JSON.parse(raw);
  }

  await db.billingWebhookEvent.upsert({
    where: { stripeEventId: event.id },
    create: {
      stripeEventId: event.id,
      type: event.type,
      payloadJson: raw.slice(0, 100000),
      processed: false,
    },
    update: {},
  });

  if (event.type === 'checkout.session.completed' || event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
    const userId = event.data?.object?.client_reference_id || event.data?.object?.metadata?.userId;
    const status = event.type === 'customer.subscription.deleted' ? 'canceled' : event.data?.object?.status || 'active';
    if (userId) {
      await db.subscription.upsert({
        where: { userId },
        create: { userId, tier: 'pro', status },
        update: { status },
      });
    }
    await db.billingWebhookEvent.updateMany({ where: { stripeEventId: event.id }, data: { processed: true } });
  }

  return NextResponse.json({ received: true });
}

// Stripe signature verification (v1 scheme) without the SDK.
function verifyStripeSignature(payload: string, header: string, secret: string): boolean {
  try {
    const parts = Object.fromEntries(header.split(',').map((p) => p.split('=').map((s) => s.trim()) as [string, string]));
    const timestamp = parts.t;
    const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
    const sigv1 = parts.v1 || '';
    const a = Buffer.from(expected);
    const b = Buffer.from(sigv1);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
