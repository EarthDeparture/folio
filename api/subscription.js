import { authenticate } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  const auth = await authenticate(req, res);
  if (!auth) return;
  const { sb, user } = auth;

  console.log('[subscription API] user.id:', user.id);

  const { data, error } = await sb
    .from('user_plans')
    .select('plan, current_period_end, cancel_at_period_end')
    .eq('user_id', user.id)
    .single();

  if (error) {
    console.error('[subscription API] DB error:', error);
    return res.status(500).json({ error: error.message });
  }

  console.log('[subscription API] query result:', data);

  if (!data) return res.json({ plan: 'free' });

  res.json({
    plan:               data.plan,
    currentPeriodEnd:   data.current_period_end,
    cancelAtPeriodEnd:  data.cancel_at_period_end,
  });
}
