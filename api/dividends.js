import { authenticateSb } from './_lib.js';

const AV_BASE = 'https://www.alphavantage.co/query';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  const sb = await authenticateSb(req, res);
  if (!sb) return;

  const symbol = (req.query.symbol || '').toUpperCase().trim();
  if (!symbol) return res.status(400).json({ error: 'symbol required' });

  const AV_KEY = process.env.AV_KEY;
  if (!AV_KEY) return res.json({ dividends: [] });

  let divs = null;

  try {
    const r = await fetch(
      `${AV_BASE}?function=DIVIDENDS&symbol=${encodeURIComponent(symbol)}&apikey=${AV_KEY}`,
      { signal: AbortSignal.timeout(15000) }
    );
    const data = await r.json();
    if (data['Note'] || data['Information']) throw new Error('Rate limited');
    if (Array.isArray(data?.data)) {
      divs = data.data.map(d => ({
        date:     d.ex_dividend_date,
        label:    d.dividend_type || 'Dividend',
        dividend: parseFloat(d.amount),
      }));
    }
  } catch(e) {
    console.error('[api/dividends] error:', e.message);
  }

  res.json({ dividends: divs || [] });
}
