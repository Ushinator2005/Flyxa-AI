import { Router, Request, Response } from 'express';
import Stripe from 'stripe';
import { authMiddleware } from '../middleware/auth';
import { supabase } from '../services/supabase';
import { AuthenticatedRequest } from '../types/index';

// Stripe subscription billing for Flyxa itself (distinct from routes/billing.ts,
// which tracks the user's prop-firm spend).
//
// Env:
//   STRIPE_SECRET_KEY      — sk_live_... / sk_test_...
//   STRIPE_PRICE_ID        — the recurring price for the Flyxa plan
//   STRIPE_WEBHOOK_SECRET  — whsec_... for the webhook endpoint
//   FRONTEND_URL           — used for checkout redirect URLs
//
// When STRIPE_SECRET_KEY is unset the API reports { configured: false } and the
// frontend treats every account as active, so dev keeps working with no keys.

const router = Router();

const stripeKey = process.env.STRIPE_SECRET_KEY?.trim();
const stripe = stripeKey ? new Stripe(stripeKey) : null;

const PRICE_ID = process.env.STRIPE_PRICE_ID?.trim() ?? '';
const FRONTEND_URL = (process.env.FRONTEND_URL ?? 'http://localhost:5173').split(',')[0].trim();

const ACTIVE_STATUSES = new Set(['active', 'trialing']);

interface SubscriptionRow {
  user_id: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  status: string | null;
  current_period_end: string | null;
}

async function getSubscriptionRow(userId: string): Promise<SubscriptionRow | null> {
  const { data, error } = await supabase
    .from('user_subscriptions')
    .select('user_id, stripe_customer_id, stripe_subscription_id, status, current_period_end')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return (data as SubscriptionRow | null) ?? null;
}

async function upsertSubscriptionRow(row: Partial<SubscriptionRow> & { user_id: string }): Promise<void> {
  const { error } = await supabase
    .from('user_subscriptions')
    .upsert({ ...row, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
  if (error) throw error;
}

// ── GET /api/subscription/status ────────────────────────────────────────────
router.get('/status', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!stripe) {
      res.json({ configured: false, active: true, status: 'unconfigured' });
      return;
    }
    const row = await getSubscriptionRow(req.userId as string);
    const status = row?.status ?? 'none';
    res.json({
      configured: true,
      active: ACTIVE_STATUSES.has(status),
      status,
      currentPeriodEnd: row?.current_period_end ?? null,
      hasCustomer: Boolean(row?.stripe_customer_id),
    });
  } catch (error) {
    console.error('subscription/status failed:', error instanceof Error ? error.message : error);
    res.status(500).json({ error: 'Could not load subscription status' });
  }
});

// ── POST /api/subscription/checkout ─────────────────────────────────────────
router.post('/checkout', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!stripe || !PRICE_ID) {
      res.status(503).json({ error: 'Billing is not configured yet' });
      return;
    }
    const userId = req.userId as string;
    const email = req.authUser?.email ?? undefined;

    // Reuse the Stripe customer if this user already has one.
    const existing = await getSubscriptionRow(userId);
    let customerId = existing?.stripe_customer_id ?? null;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email,
        metadata: { user_id: userId },
      });
      customerId = customer.id;
      await upsertSubscriptionRow({ user_id: userId, stripe_customer_id: customerId });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: PRICE_ID, quantity: 1 }],
      subscription_data: { metadata: { user_id: userId } },
      metadata: { user_id: userId },
      allow_promotion_codes: true,
      success_url: `${FRONTEND_URL}/upgrade?checkout=success`,
      cancel_url: `${FRONTEND_URL}/upgrade?checkout=cancelled`,
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error('subscription/checkout failed:', error instanceof Error ? error.message : error);
    res.status(500).json({ error: 'Could not start checkout' });
  }
});

// ── POST /api/subscription/portal ───────────────────────────────────────────
router.post('/portal', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!stripe) {
      res.status(503).json({ error: 'Billing is not configured yet' });
      return;
    }
    const row = await getSubscriptionRow(req.userId as string);
    if (!row?.stripe_customer_id) {
      res.status(400).json({ error: 'No billing profile yet — start a subscription first' });
      return;
    }
    const session = await stripe.billingPortal.sessions.create({
      customer: row.stripe_customer_id,
      return_url: `${FRONTEND_URL}/upgrade`,
    });
    res.json({ url: session.url });
  } catch (error) {
    console.error('subscription/portal failed:', error instanceof Error ? error.message : error);
    res.status(500).json({ error: 'Could not open billing portal' });
  }
});

// ── Webhook (mounted with express.raw in index.ts — NO auth, Stripe-signed) ─
export async function stripeWebhookHandler(req: Request, res: Response): Promise<void> {
  if (!stripe) {
    res.status(503).json({ error: 'Billing is not configured' });
    return;
  }
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  const signature = req.headers['stripe-signature'];
  if (!webhookSecret || !signature) {
    res.status(400).json({ error: 'Missing webhook signature' });
    return;
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(req.body as Buffer, signature, webhookSecret);
  } catch (error) {
    console.error('Stripe webhook signature verification failed:', error instanceof Error ? error.message : error);
    res.status(400).json({ error: 'Invalid signature' });
    return;
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        const userId = session.metadata?.user_id;
        if (userId && session.subscription) {
          const sub = await stripe.subscriptions.retrieve(session.subscription as string);
          await upsertSubscriptionRow({
            user_id: userId,
            stripe_customer_id: (session.customer as string) ?? null,
            stripe_subscription_id: sub.id,
            status: sub.status,
            current_period_end: sub.items.data[0]?.current_period_end
              ? new Date(sub.items.data[0].current_period_end * 1000).toISOString()
              : null,
          });
        }
        break;
      }
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        const userId = sub.metadata?.user_id;
        if (userId) {
          await upsertSubscriptionRow({
            user_id: userId,
            stripe_customer_id: (sub.customer as string) ?? null,
            stripe_subscription_id: sub.id,
            status: event.type === 'customer.subscription.deleted' ? 'canceled' : sub.status,
            current_period_end: sub.items.data[0]?.current_period_end
              ? new Date(sub.items.data[0].current_period_end * 1000).toISOString()
              : null,
          });
        }
        break;
      }
      default:
        break;
    }
    res.json({ received: true });
  } catch (error) {
    console.error('Stripe webhook handling failed:', error instanceof Error ? error.message : error);
    res.status(500).json({ error: 'Webhook handling failed' });
  }
}

export default router;
