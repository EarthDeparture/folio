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

  let overview = null;

  // ── Alpha Vantage OVERVIEW ───────────────────────────────────────
  if (AV_KEY) {
    try {
      const r = await fetch(
        `${AV_BASE}?function=OVERVIEW&symbol=${encodeURIComponent(symbol)}&apikey=${AV_KEY}`,
        { signal: AbortSignal.timeout(15000) }
      );
      const data = await r.json();
      if (data['Note'] || data['Information']) throw Object.assign(new Error('Rate limited'), { isRateLimit: true });
      if (data?.Symbol) {
        overview = {
          symbol,
          name:              data.Name || symbol,
          dividendYield:     parseFloat(data.DividendYield)        || 0,
          dividendPerShare:  parseFloat(data.DividendPerShare)     || 0,
          pe:                parseFloat(data.TrailingPE)           || null,
          marketCap:         parseFloat(data.MarketCapitalization) || null,
          yearHigh:          parseFloat(data['52WeekHigh'])        || null,
          yearLow:           parseFloat(data['52WeekLow'])         || null,
        };
      }
    } catch(e) {
      if (!e.isRateLimit) console.error('[api/overview] AV error:', e.message);
      // fall through to Finnhub
    }
  }

  // ── Finnhub fallback — metric endpoint has dividendYieldIndicatedAnnual ──
  if (!overview && FH_KEY) {
    try {
      const [metricR, profileR] = await Promise.all([
        fetch(`${FH_BASE}/stock/metric?symbol=${encodeURIComponent(symbol)}&metric=all&token=${FH_KEY}`, { signal: AbortSignal.timeout(15000) }),
        fetch(`${FH_BASE}/stock/profile2?symbol=${encodeURIComponent(symbol)}&token=${FH_KEY}`,         { signal: AbortSignal.timeout(15000) }),
      ]);
      const [metric, profile] = await Promise.all([metricR.json(), profileR.json()]);
      const m = metric?.metric || {};
      // dividendYieldIndicatedAnnual is already in % (e.g. 1.57 = 1.57%) — convert to decimal
      const yieldPct = parseFloat(m.dividendYieldIndicatedAnnual) || 0;
      overview = {
        symbol,
        name:             profile?.name || symbol,
        dividendYield:    yieldPct / 100,
        dividendPerShare: parseFloat(m['currentDividendYieldTTM']) || 0,
        pe:               parseFloat(m.peBasicExclExtraTTM)        || null,
        marketCap:        profile?.marketCapitalization ? profile.marketCapitalization * 1e6 : null,
        yearHigh:         parseFloat(m['52WeekHigh'])              || null,
        yearLow:          parseFloat(m['52WeekLow'])               || null,
      };
    } catch(e) {
      console.error('[api/overview] Finnhub error:', e.message);
    }
  }

  if (!overview) return res.json({ overview: null });

  // Update Supabase quotes cache with real dividend yield
  await sb.from('quotes').upsert({
    symbol,
    name:           overview.name,
    dividend_yield: overview.dividendYield,
    pe:             overview.pe,
    market_cap:     overview.marketCap,
    year_high:      overview.yearHigh,
    year_low:       overview.yearLow,
    cached_at:      new Date().toISOString(),
  }, { onConflict: 'symbol', ignoreDuplicates: false });

  res.json({ overview });
}
