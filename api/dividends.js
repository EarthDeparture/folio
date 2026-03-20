import { authenticateSb } from './_lib.js';

const AV_BASE = 'https://www.alphavantage.co/query';
const FH_BASE = 'https://finnhub.io/api/v1';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  const sb = await authenticateSb(req, res);
  if (!sb) return;

  const symbol = (req.query.symbol || '').toUpperCase().trim();
  if (!symbol) return res.status(400).json({ error: 'symbol required' });

  const AV_KEY = process.env.AV_KEY;
  const FH_KEY = process.env.FH_KEY;

  let divs = null;

  // ── Alpha Vantage (premium key required for DIVIDENDS endpoint) ──
  if (AV_KEY) {
    try {
      const r = await fetch(
        `${AV_BASE}?function=DIVIDENDS&symbol=${encodeURIComponent(symbol)}&apikey=${AV_KEY}`,
        { signal: AbortSignal.timeout(15000) }
      );
      const data = await r.json();
      if (data['Note'] || data['Information']) throw Object.assign(new Error('Rate limited'), { isRateLimit: true });
      if (Array.isArray(data?.data) && data.data.length > 0) {
        divs = data.data.map(d => ({
          date:     d.ex_dividend_date,
          label:    d.dividend_type || 'Dividend',
          dividend: parseFloat(d.amount),
        }));
      }
    } catch(e) {
      if (!e.isRateLimit) console.error('[api/dividends] AV error:', e.message);
      // fall through to Finnhub
    }
  }

  // ── Finnhub fallback (free tier supports dividend history) ───────
  if (!divs && FH_KEY) {
    try {
      // Fetch 5 years of history for reliable projection intervals
      const to   = new Date().toISOString().slice(0, 10);
      const from = new Date(Date.now() - 5 * 365.25 * 86400000).toISOString().slice(0, 10);
      const r = await fetch(
        `${FH_BASE}/stock/dividend?symbol=${encodeURIComponent(symbol)}&from=${from}&to=${to}&token=${FH_KEY}`,
        { signal: AbortSignal.timeout(15000) }
      );
      const data = await r.json();
      if (Array.isArray(data) && data.length > 0) {
        divs = data.map(d => ({
          date:     d.date,
          label:    'Dividend',
          dividend: parseFloat(d.amount),
        })).filter(d => d.date && d.dividend > 0);
      }
    } catch(e) {
      console.error('[api/dividends] Finnhub error:', e.message);
    }
  }

  res.json({ dividends: divs || [] });
}
