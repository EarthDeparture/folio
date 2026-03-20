import { authenticate } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  const auth = await authenticate(req, res);
  if (!auth) return;
  const { sb, user } = auth;

  const { data, error } = await sb
    .from('user_plans')
    .select('plan, current_period_end, cancel_at_period_end')
    .eq('user_id', user.id)
    .single();

  if (!data) return res.json({ plan: 'free', _debug: { userId: user.id, error: error?.message } });

  res.json({
    plan:               data.plan,
    currentPeriodEnd:   data.current_period_end,
    cancelAtPeriodEnd:  data.cancel_at_period_end,
  });
}
