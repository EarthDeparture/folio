import Stripe from 'stripe';
import { authenticate } from './_lib.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const auth = await authenticate(req, res);
  if (!auth) return;
  const { sb, user } = auth;

  const { priceId, successUrl, cancelUrl } = req.body || {};
  if (!priceId || !successUrl || !cancelUrl) {
    return res.status(400).json({ error: 'priceId, successUrl, and cancelUrl are required' });
  }

  // Look up existing stripe_customer_id
  const { data: plan } = await sb
    .from('user_plans')
    .select('stripe_customer_id')
    .eq('user_id', user.id)
    .single();

  let customerId = plan?.stripe_customer_id;

  // Create Stripe customer if none exists
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user.email,
      metadata: { userId: user.id },
    });
    customerId = customer.id;

    // Store the new customer ID via service role (bypasses RLS)
    await sb.from('user_plans').upsert(
      { user_id: user.id, stripe_customer_id: customerId, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' }
    );
  }

  const session = await stripe.checkout.sessions.create({
    customer:            customerId,
    line_items:          [{ price: priceId, quantity: 1 }],
    mode:                'subscription',
    success_url:         successUrl,
    cancel_url:          cancelUrl,
    client_reference_id: user.id,
  });

  res.json({ url: session.url });
}
