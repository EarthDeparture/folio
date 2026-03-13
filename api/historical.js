import { authenticate } from './_lib.js';

const AV_BASE = 'https://www.alphavantage.co/query';
const FH_BASE = 'https://finnhub.io/api/v1';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  const sb = await authenticate(req, res);
  if (!sb) return;

  const symbol = (req.query.symbol || '').toUpperCase().trim();
  if (!symbol) return res.status(400).json({ error: 'symbol required' });

  const AV_KEY = process.env.AV_KEY;
  const FH_KEY = process.env.FH_KEY;

  let prices = null;

  // ── Alpha Vantage ──────────────────────────────────────────────
  if (AV_KEY) {
    try {
      const r = await fetch(
        `${AV_BASE}?function=TIME_SERIES_DAILY&symbol=${encodeURIComponent(symbol)}&outputsize=full&apikey=${AV_KEY}`,
        { signal: AbortSignal.timeout(30000) }
      );
      const data = await r.json();
      if (data['Note'] || data['Information']) throw Object.assign(new Error('Rate limited'), { isRateLimit: true });
      const ts = data?.['Time Series (Daily)'];
      if (ts) {
        prices = Object.keys(ts)
          .sort()
          .reverse()
          .map(date => ({ date, close: parseFloat(ts[date]['4. close']) }));
      }
    } catch(e) {
      if (!e.isRateLimit) console.error('[api/historical] AV error:', e.message);
    }
  }

  // ── Finnhub fallback ───────────────────────────────────────────
  if (!prices && FH_KEY) {
    try {
      const to   = Math.floor(Date.now() / 1000);
      const from = to - 366 * 86400;
      const r = await fetch(
        `${FH_BASE}/stock/candle?symbol=${encodeURIComponent(symbol)}&resolution=D&from=${from}&to=${to}&token=${FH_KEY}`,
        { signal: AbortSignal.timeout(30000) }
      );
      const d = await r.json();
      if (d?.s === 'ok' && Array.isArray(d.c)) {
        prices = d.t
          .map((ts, i) => ({ date: new Date(ts * 1000).toISOString().split('T')[0], close: d.c[i] }))
          .sort((a, b) => b.date.localeCompare(a.date));
      }
    } catch(e) {
      console.error('[api/historical] Finnhub error:', e.message);
    }
  }

  res.json({ history: prices || [] });
}
