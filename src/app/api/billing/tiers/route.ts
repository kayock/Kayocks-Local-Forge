import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

// Subscription tiers. Prices are placeholders — product decision pending.
// Billing is DISABLED in the prototype build (see /api/billing/status).
export const TIERS = [
  {
    id: 'free',
    name: 'Free',
    priceMonthly: 0,
    features: [
      'Full IDE: editor, file explorer, terminal, preview',
      'Unlimited local model connections',
      'Unlimited local inference (your hardware, your tokens)',
      '1 authorized workspace',
      'Community support',
    ],
  },
  {
    id: 'pro',
    name: 'Pro',
    priceMonthly: 12,
    highlight: true,
    features: [
      'Everything in Free',
      'Unlimited workspaces',
      'Multi-agent pipelines (planner → coder → tester → reviewer)',
      'Per-stage model routing',
      'Project metadata sync across devices',
      'Priority support',
    ],
  },
  {
    id: 'team',
    name: 'Team',
    priceMonthly: 29,
    features: [
      'Everything in Pro, per member',
      'Team management and shared workspaces',
      'Centralized usage analytics for hosted services',
      'SSO (roadmap)',
      'Dedicated support',
    ],
  },
];

export async function GET() {
  return NextResponse.json({ tiers: TIERS, enabled: billingEnabled() });
}

export function billingEnabled(): boolean {
  return process.env.SUBSCRIPTIONS_ENABLED === 'true' && !!process.env.STRIPE_SECRET_KEY;
}
