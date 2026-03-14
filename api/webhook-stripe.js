import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const sig = req.headers['stripe-signature'];
  let event;
  try {
    const raw = await getRawBody(req);
    event = stripe.webhooks.constructEvent(raw, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    console.error('[webhook-stripe] Signature verification failed:', e.message);
    return res.status(400).json({ error: e.message });
  }

  const sb = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { db: { schema: 'folio' } }
  );

  // Statuses that should retain premium access (e.g. past_due = payment failed but
  // still in grace period; trialing = free trial active)
  const PREMIUM_STATUSES = ['active', 'trialing', 'past_due'];

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const userId = session.client_reference_id;
      if (!userId) throw new Error('No client_reference_id on checkout session');

      // Fetch subscription for period end
      const sub = await stripe.subscriptions.retrieve(session.subscription);
      await sb.from('user_plans').upsert({
        user_id:                userId,
        plan:                   'premium',
        stripe_customer_id:     session.customer,
        stripe_subscription_id: session.subscription,
        stripe_price_id:        sub.items.data[0]?.price.id || null,
        current_period_end:     new Date(sub.current_period_end * 1000).toISOString(),
        cancel_at_period_end:   sub.cancel_at_period_end,
        updated_at:             new Date().toISOString(),
      }, { onConflict: 'user_id' });

    } else if (event.type === 'customer.subscription.updated') {
      const sub = event.data.object;
      const customer = await stripe.customers.retrieve(sub.customer);
      const userId = customer.metadata?.userId;
      if (!userId) throw new Error('No userId in Stripe customer metadata');

      await sb.from('user_plans').upsert({
        user_id:                userId,
        plan:                   PREMIUM_STATUSES.includes(sub.status) ? 'premium' : 'free',
        stripe_customer_id:     sub.customer,
        stripe_subscription_id: sub.id,
        stripe_price_id:        sub.items.data[0]?.price.id || null,
        current_period_end:     new Date(sub.current_period_end * 1000).toISOString(),
        cancel_at_period_end:   sub.cancel_at_period_end,
        updated_at:             new Date().toISOString(),
      }, { onConflict: 'user_id' });

    } else if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      const customer = await stripe.customers.retrieve(sub.customer);
      const userId = customer.metadata?.userId;
      if (!userId) throw new Error('No userId in Stripe customer metadata');

      await sb.from('user_plans').upsert({
        user_id:                userId,
        plan:                   'free',
        stripe_subscription_id: null,
        stripe_price_id:        null,
        current_period_end:     null,
        cancel_at_period_end:   false,
        updated_at:             new Date().toISOString(),
      }, { onConflict: 'user_id' });
    }
  } catch (e) {
    console.error('[webhook-stripe] Handler error:', e.message);
    return res.status(500).json({ error: 'Webhook handler failed' });
  }

  res.json({ received: true });
}
