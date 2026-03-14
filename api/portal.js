import Stripe from 'stripe';
import { authenticate } from './_lib.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const auth = await authenticate(req, res);
  if (!auth) return;
  const { sb, user } = auth;

  const { returnUrl } = req.body || {};

  const { data: plan } = await sb
    .from('user_plans')
    .select('stripe_customer_id')
    .eq('user_id', user.id)
    .single();

  if (!plan?.stripe_customer_id) {
    return res.status(400).json({ error: 'No subscription found' });
  }

  const session = await stripe.billingPortal.sessions.create({
    customer:   plan.stripe_customer_id,
    return_url: returnUrl || process.env.APP_URL || 'https://dividnd.com/dashboard.html',
  });

  res.json({ url: session.url });
}
