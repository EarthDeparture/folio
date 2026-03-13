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

  let quote = null;

  // ── Alpha Vantage ──────────────────────────────────────────────
  if (AV_KEY) {
    try {
      const r = await fetch(
        `${AV_BASE}?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(symbol)}&apikey=${AV_KEY}`,
        { signal: AbortSignal.timeout(15000) }
      );
      const data = await r.json();
      if (data['Note'] || data['Information']) throw Object.assign(new Error('Rate limited'), { isRateLimit: true });
      const raw = data?.['Global Quote'];
      if (raw?.['01. symbol']) {
        quote = {
          symbol:            raw['01. symbol'],
          name:              symbol,
          price:             parseFloat(raw['05. price']),
          change:            parseFloat(raw['09. change']) || 0,
          changesPercentage: parseFloat(raw['10. change percent']) || 0,
          marketCap:         raw['06. market cap'] || null,
          pe:                raw['07. pe ratio'] || null,
          yearHigh:          parseFloat(raw['03. high']) || null,
          yearLow:           parseFloat(raw['04. low']) || null,
          dividendYield:     parseFloat(raw['08. dividend yield']) || 0,
        };
      }
    } catch(e) {
      if (!e.isRateLimit) console.error('[api/quote] AV error:', e.message);
      // fall through to Finnhub
    }
  }

  // ── Finnhub fallback ───────────────────────────────────────────
  if (!quote && FH_KEY) {
    try {
      const [qr, pr] = await Promise.all([
        fetch(`${FH_BASE}/quote?symbol=${encodeURIComponent(symbol)}&token=${FH_KEY}`,          { signal: AbortSignal.timeout(15000) }),
        fetch(`${FH_BASE}/stock/profile2?symbol=${encodeURIComponent(symbol)}&token=${FH_KEY}`, { signal: AbortSignal.timeout(15000) }),
      ]);
      const [q, p] = await Promise.all([qr.json(), pr.json()]);
      if (q?.c) {
        quote = {
          symbol,
          name:              p?.name || symbol,
          price:             q.c,
          change:            q.d  ?? 0,
          changesPercentage: q.dp ?? 0,
          marketCap:         p?.marketCapitalization ? p.marketCapitalization * 1e6 : null,
          pe:                null,
          yearHigh:          null,
          yearLow:           null,
          dividendYield:     0,
        };
      }
    } catch(e) {
      console.error('[api/quote] Finnhub error:', e.message);
    }
  }

  if (!quote) return res.status(404).json({ error: 'No quote data available' });

  // ── Write to shared quote cache (service role bypasses RLS) ───
  await sb.from('quotes').upsert({
    symbol:             quote.symbol,
    name:               quote.name || null,
    price:              quote.price ?? null,
    change:             quote.change ?? null,
    changes_percentage: quote.changesPercentage ?? null,
    market_cap:         quote.marketCap || null,
    pe:                 quote.pe || null,
    year_high:          quote.yearHigh ?? null,
    year_low:           quote.yearLow ?? null,
    dividend_yield:     quote.dividendYield ?? 0,
    cached_at:          new Date().toISOString(),
  }, { onConflict: 'symbol' });

  res.json({ quote });
}
