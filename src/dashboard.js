import { Chart, registerables } from 'chart.js';
import { createClient } from '@supabase/supabase-js';

Chart.register(...registerables);

// ═══════════════════════════════════════════════════════════════
// FOLIO · Dashboard
// Auth: Supabase RLS — all ownership enforced at DB level via
//       auth.uid(). No browser_id. JWT auto-attached by client.
// ═══════════════════════════════════════════════════════════════

// ── CONFIG ─────────────────────────────────────────────────────
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || '';
const AV_BASE      = 'https://www.alphavantage.co/query';
const FH_BASE      = 'https://finnhub.io/api/v1';

const sbKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';
const avKey = import.meta.env.VITE_AV_KEY || '';
const fhKey = import.meta.env.VITE_FH_KEY || '';

const CACHE_Q = 24 * 60 * 60 * 1000;  // 24 h — quote TTL
const CACHE_H = 24 * 60 * 60 * 1000;  // 24 h — history TTL

// ── STATE ──────────────────────────────────────────────────────
const S = {
  db:             null,
  user:           null,
  avKey:          '',
  fhKey:          '',
  portfolios:     [],
  currentFolioId: localStorage.getItem('folio_current_id') || null,
  positions:      [],
  classes:        [],
  quotes:         {},
  period:         '1M',
  sortCol:        'value',
  sortDir:        -1,
  drip:           true,
  charts:         { port: null, alloc: null, calc: null, stock: null },
};

// Separate editor state so Settings edits do not mutate live positions
let editorRows = [];
let editorClasses = [];
let _deletedClassIds = [];
let _originalClassIds = [];

// Track gain state for port chart gradient closure
let portChartIsGain = true;

// Suppress duplicate "using Finnhub fallback" toasts within a single load cycle
let _avRateLimited = false;

// Debounce handle for calculator
let _calcTimer = null;

const COLORS = [
  '#14f0a8','#5b8af0','#f05b8a','#f0c05b','#a05bf0',
  '#5be8f0','#f0905b','#8af05b','#c05bf0','#f05b5b',
  '#5bd4f0','#f0d65b','#5bf0c0','#e05bf0','#90f05b',
  '#5b90f0','#f0a05b','#5bf080','#f07a5b','#a0c05b',
];

// ── HELPERS ────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const f = {
  $:   (n, d = 2) => n == null ? '—' : new Intl.NumberFormat('en-US', { style:'currency', currency:'USD', minimumFractionDigits:d, maximumFractionDigits:d }).format(n),
  pct: (n, d = 2) => n == null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(d)}%`,
  num: (n, d = 0) => n == null ? '—' : n.toFixed(d),
  compact: n => n == null ? '—' : new Intl.NumberFormat('en-US', { notation:'compact', maximumFractionDigits:1 }).format(n),
  date: s => new Date(s + 'T00:00:00').toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' }),
};

const sign = n => n >= 0 ? 'gain' : 'loss';

// ── TOAST ──────────────────────────────────────────────────────
function toast(msg, type = 'success') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('toast-container').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s, transform .25s';
    el.style.opacity = '0';
    el.style.transform = 'translateX(12px)';
    setTimeout(() => el.remove(), 260);
  }, 3500);
}

// ── ERROR CLASSIFIER ───────────────────────────────────────────
function isPermissionDenied(error) {
  if (!error) return false;
  const msg = error.message?.toLowerCase() || '';
  return (
    error.code === 'PGRST014' ||
    error.code === '42501' ||
    error.status === 403 ||
    msg.includes('permission denied') ||
    msg.includes('row-level security') ||
    msg.includes('new row violates')
  );
}

function isRateLimit(error) {
  if (!error) return false;
  if (error.isRateLimit) return true;
  const msg = error.message?.toLowerCase() || '';
  return msg.includes('rate limit') || msg.includes('call frequency') || msg.includes('thank you');
}

function handleDbError(error, context = '') {
  if (isPermissionDenied(error)) {
    console.error(`[FOLIO] Permission denied — ${context} | user: ${S.user?.id}`, error);
    toast('Permission denied. Please sign out and sign back in.', 'error');
    return;
  }
  console.error(`[FOLIO] DB error — ${context}`, error);
  toast(error.message || 'Database error', 'error');
}

// ── SUPABASE CLIENT ────────────────────────────────────────────
function initDB() {
  S.db = createClient(SUPABASE_URL, sbKey, {
    db: { schema: 'folio' },
    auth: {
      autoRefreshToken:   true,
      persistSession:     true,
      detectSessionInUrl: true,
    },
  });
}

// ── LOCAL CACHE ────────────────────────────────────────────────
const Cache = {
  set(k, d, ttl) {
    try { localStorage.setItem('folio_c_' + k, JSON.stringify({ d, exp: Date.now() + ttl })); } catch(e) {}
  },
  get(k) {
    try {
      const c = JSON.parse(localStorage.getItem('folio_c_' + k));
      if (c && Date.now() < c.exp) return c.d;
    } catch {}
    return null;
  },
  clearQuotes() {
    Object.keys(localStorage)
      .filter(k => k.startsWith('folio_c_q1_') || k.startsWith('folio_c_h_') || k.startsWith('folio_c_div_'))
      .forEach(k => localStorage.removeItem(k));
    toast('Quote cache cleared');
  },
};

// ── DATABASE LAYER ─────────────────────────────────────────────
// RLS enforces ownership at DB level using auth.uid().
// Application code does NOT filter by user — the DB handles it.
const DB = {
  async listPortfolios() {
    const { data, error } = await S.db
      .from('portfolios')
      .select('*')
      .order('created_at', { ascending: true });
    if (error) { handleDbError(error, 'listPortfolios'); throw error; }
    return data || [];
  },

  async createPortfolio(name) {
    if (!S.user?.id) throw new Error('Not authenticated - please sign in again.');
    const { data, error } = await S.db
      .from('portfolios')
      .insert({ name: name.trim(), owner: S.user.id })
      .select()
      .single();
    if (error) { handleDbError(error, 'createPortfolio'); throw error; }
    return data;
  },

  async deletePortfolio(id) {
    const { error } = await S.db.from('portfolios').delete().eq('id', id);
    if (error) { handleDbError(error, 'deletePortfolio'); throw error; }
  },

  async listPositions(folioId) {
    const { data, error } = await S.db
      .from('positions')
      .select('*')
      .eq('folio_id', folioId)
      .order('symbol', { ascending: true });
    if (error) { handleDbError(error, 'listPositions'); throw error; }
    return data || [];
  },

  async upsertPosition(folioId, symbol, shares, avgCost, color, targetWeight, classId = null) {
    const { data, error } = await S.db
      .from('positions')
      .upsert(
        {
          folio_id:      folioId,
          symbol:        symbol.toUpperCase(),
          shares,
          avg_cost:      avgCost,
          color,
          target_weight: targetWeight ?? 0,
          class_id:      classId || null,
          updated_at:    new Date().toISOString(),
        },
        { onConflict: 'folio_id,symbol' }
      )
      .select()
      .single();
    if (error) { handleDbError(error, `upsertPosition ${symbol}`); throw error; }
    return data;
  },

  async listClasses(folioId) {
    const { data, error } = await S.db
      .from('classes')
      .select('*')
      .eq('folio_id', folioId)
      .order('sort_order', { ascending: true });
    if (error) { handleDbError(error, 'listClasses'); throw error; }
    return data || [];
  },

  async upsertClass(folioId, { id, name, targetWeight, color, sortOrder }) {
    const { data, error } = await S.db
      .from('classes')
      .upsert(
        {
          id:            id,
          folio_id:      folioId,
          name:          (name || 'Unnamed').trim(),
          target_weight: targetWeight ?? 0,
          color:         color || null,
          sort_order:    sortOrder ?? 0,
          updated_at:    new Date().toISOString(),
        },
        { onConflict: 'id' }
      )
      .select()
      .single();
    if (error) { handleDbError(error, `upsertClass ${name}`); throw error; }
    return data;
  },

  async deleteClass(id) {
    const { error } = await S.db.from('classes').delete().eq('id', id);
    if (error) { handleDbError(error, `deleteClass ${id}`); throw error; }
  },

  async deletePosition(folioId, symbol) {
    const { error } = await S.db
      .from('positions')
      .delete()
      .eq('folio_id', folioId)
      .eq('symbol', symbol);
    if (error) { handleDbError(error, `deletePosition ${symbol}`); throw error; }
  },

  async getQuote(symbol, maxAgeMs) {
    try {
      const { data, error } = await S.db
        .from('quotes')
        .select('*')
        .eq('symbol', symbol.toUpperCase())
        .maybeSingle();
      if (error || !data) return null;
      if (maxAgeMs && data.cached_at) {
        const age = Date.now() - new Date(data.cached_at).getTime();
        if (age > maxAgeMs) return null;
      }
      return data;
    } catch {
      return null;
    }
  },

  async upsertQuote(q) {
    S.db.from('quotes').upsert({
      symbol:             q.symbol,
      name:               q.name || null,
      price:              q.price ?? null,
      change:             q.change ?? null,
      changes_percentage: q.changesPercentage ?? null,
      market_cap:         q.marketCap || null,
      pe:                 q.pe || null,
      year_high:          q.yearHigh ?? null,
      year_low:           q.yearLow ?? null,
      dividend_yield:     q.dividendYield ?? 0,
      cached_at:          new Date().toISOString(),
    }, { onConflict: 'symbol' }).then(({ error }) => {
      if (error) console.warn('[FOLIO] Quote cache write skipped:', error.message);
    });
  },
};

// ── ALPHA VANTAGE API ──────────────────────────────────────────
const API = {
  async _fetch(url) {
    const key = S.avKey.trim();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const r = await fetch(`${url}&apikey=${encodeURIComponent(key)}`, { signal: ctrl.signal });
      clearTimeout(timer);
      const data = JSON.parse(await r.text());
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      if (data['Error Message']) throw new Error(data['Error Message']);
      // Both 'Note' (rate limit) and 'Information' (free plan exhausted) signal rate limiting
      if (data['Note'] || data['Information']) {
        throw Object.assign(
          new Error('Alpha Vantage rate limit reached — try again later'),
          { isRateLimit: true }
        );
      }
      return data;
    } catch(e) {
      clearTimeout(timer);
      throw e.name === 'AbortError' ? new Error('Request timed out') : e;
    }
  },

  async _oneQuote(symbol) {
    const cached = Cache.get('q1_' + symbol);
    if (cached) return cached;

    // Try shared DB cache (cross-user) before hitting any API
    const dbQ = await DB.getQuote(symbol, CACHE_Q);
    if (dbQ) {
      const q = {
        symbol:            dbQ.symbol,
        name:              dbQ.name || dbQ.symbol,
        price:             dbQ.price ?? null,
        change:            dbQ.change ?? 0,
        changesPercentage: dbQ.changes_percentage ?? 0,
        marketCap:         dbQ.market_cap || null,
        pe:                dbQ.pe || null,
        yearHigh:          dbQ.year_high ?? null,
        yearLow:           dbQ.year_low ?? null,
        dividendYield:     dbQ.dividend_yield ?? 0,
      };
      Cache.set('q1_' + symbol, q, CACHE_Q);
      return q;
    }

    // Try Alpha Vantage; on rate limit automatically fall back to Finnhub
    let q = null;
    try {
      const d = await this._fetch(`${AV_BASE}?function=GLOBAL_QUOTE&symbol=${symbol}`);
      const raw = d?.['Global Quote'];
      if (raw?.['01. symbol']) {
        q = {
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
      if (isRateLimit(e) && S.fhKey) {
        if (!_avRateLimited) {
          toast('Alpha Vantage limit reached — switching to Finnhub', 'info');
          _avRateLimited = true;
        }
        q = await FINNHUB.quote(symbol);
      } else {
        throw e;
      }
    }

    if (q) {
      Cache.set('q1_' + symbol, q, CACHE_Q);
      DB.upsertQuote(q);
    }
    return q;
  },

  async quotes(symbols) {
    _avRateLimited = false; // reset toast flag at start of each batch load
    const results = [];
    for (let i = 0; i < symbols.length; i += 5) {
      const batch = await Promise.all(
        symbols.slice(i, i + 5).map(sym =>
          this._oneQuote(sym).catch(e => { console.error(`[FOLIO] Quote failed ${sym}:`, e.message); return null; })
        )
      );
      results.push(...batch.filter(Boolean));
      if (i + 5 < symbols.length) await sleep(12000);
    }
    return results;
  },

  // Returns full 1Y+ history sorted newest-first.
  // Cache key is per-symbol only — switching periods reuses this cache
  // instead of triggering new API calls.
  async historical(symbol) {
    const cKey = `h_${symbol}`;
    const cached = Cache.get(cKey);
    if (cached) return cached;

    let prices = null;
    try {
      const d = await this._fetch(`${AV_BASE}?function=TIME_SERIES_DAILY&symbol=${symbol}&outputsize=full`);
      const ts = d?.['Time Series (Daily)'];
      if (ts) {
        prices = Object.keys(ts)
          .sort()
          .reverse()
          .map(date => ({ date, close: parseFloat(ts[date]['4. close']) }));
      }
    } catch(e) {
      if (isRateLimit(e) && S.fhKey) {
        prices = await FINNHUB.historical(symbol);
      } else {
        throw e;
      }
    }

    if (prices?.length) Cache.set(cKey, prices, CACHE_H);
    return prices || [];
  },

  async dividends(symbol) {
    const cKey = `div_${symbol}`;
    const cached = Cache.get(cKey);
    if (cached) return cached;

    let divs = null;
    try {
      const d = await this._fetch(`${AV_BASE}?function=DIVIDENDS&symbol=${symbol}`);
      const data = d?.data;
      if (Array.isArray(data)) {
        divs = data.map(div => ({
          date:     div.ex_dividend_date,
          label:    div.dividend_type || 'Dividend',
          dividend: parseFloat(div.amount),
        }));
      }
    } catch(e) {
      if (isRateLimit(e) && S.fhKey) {
        divs = await FINNHUB.dividends(symbol);
      } else {
        throw e;
      }
    }

    if (divs?.length) Cache.set(cKey, divs, CACHE_H);
    return divs || [];
  },
};

// ── FINNHUB PROVIDER (Fallback) ────────────────────────────────
// Used automatically when Alpha Vantage rate limits are hit.
// Free tier: 60 req/min — no credit card required.
// Dividend history not available on free plan (returns empty array).
const FINNHUB = {
  async _fetch(path) {
    const key = S.fhKey.trim();
    if (!key) throw new Error('No Finnhub API key configured');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const r = await fetch(`${FH_BASE}${path}&token=${encodeURIComponent(key)}`, { signal: ctrl.signal });
      clearTimeout(timer);
      if (r.status === 429) throw Object.assign(new Error('Finnhub rate limit reached'), { isRateLimit: true });
      if (!r.ok) throw new Error(`Finnhub HTTP ${r.status}`);
      return await r.json();
    } catch(e) {
      clearTimeout(timer);
      throw e.name === 'AbortError' ? new Error('Request timed out') : e;
    }
  },

  async quote(symbol) {
    const [q, p] = await Promise.all([
      this._fetch(`/quote?symbol=${encodeURIComponent(symbol)}`),
      this._fetch(`/stock/profile2?symbol=${encodeURIComponent(symbol)}`),
    ]);
    // c === 0 means no data (unknown symbol or market closed with no price)
    if (!q || q.c == null || q.c === 0) return null;
    return {
      symbol,
      name:              p?.name || symbol,
      price:             q.c,
      change:            q.d  ?? 0,
      changesPercentage: q.dp ?? 0,
      marketCap:         p?.marketCapitalization ? p.marketCapitalization * 1e6 : null,
      pe:                null,   // requires Finnhub paid metric endpoint
      yearHigh:          null,   // requires Finnhub paid metric endpoint
      yearLow:           null,
      dividendYield:     0,
      _provider:         'finnhub',
    };
  },

  async historical(symbol) {
    const to   = Math.floor(Date.now() / 1000);
    const from = to - 366 * 86400; // 366 days of daily candles
    const d = await this._fetch(
      `/stock/candle?symbol=${encodeURIComponent(symbol)}&resolution=D&from=${from}&to=${to}`
    );
    if (!d || d.s !== 'ok' || !Array.isArray(d.c)) return [];
    return d.t
      .map((ts, i) => ({ date: new Date(ts * 1000).toISOString().split('T')[0], close: d.c[i] }))
      .sort((a, b) => b.date.localeCompare(a.date)); // newest first, matches AV shape
  },

  async dividends() { return []; }, // Not available on Finnhub free tier
};

// ── PORTFOLIO MATH ─────────────────────────────────────────────
const Port = {
  value() { return S.positions.reduce((s, h) => s + (S.quotes[h.symbol]?.price ?? 0) * h.shares, 0); },
  cost()  { return S.positions.reduce((s, h) => s + h.avg_cost * h.shares, 0); },
  dayGainAbs() {
    return S.positions.reduce((s, h) => {
      const q = S.quotes[h.symbol]; if (!q) return s;
      const prev = q.price / (1 + (q.changesPercentage || 0) / 100);
      return s + (q.price - prev) * h.shares;
    }, 0);
  },
  rows() {
    const total = S.positions.reduce((s, h) => s + (S.quotes[h.symbol]?.price ?? 0) * h.shares, 0);
    // Pre-compute per-class total values for intra-class % calculation
    const classVals = {};
    S.positions.forEach(h => {
      if (h.class_id) {
        classVals[h.class_id] = (classVals[h.class_id] || 0) + (S.quotes[h.symbol]?.price ?? 0) * h.shares;
      }
    });

    return S.positions.map((h, i) => {
      const q   = S.quotes[h.symbol];
      const px  = q?.price ?? null;
      const val = px != null ? px * h.shares : null;
      const cost= h.avg_cost * h.shares;
      const ret = val != null && cost > 0 ? ((val - cost) / cost) * 100 : null;
      const day = q?.changesPercentage ?? null;
      const div = q?.dividendYield ? q.dividendYield * 100 : 0;
      const cls      = S.classes.find(c => c.id === h.class_id) ?? null;
      const intraTgt = typeof h.target_weight === 'number' ? h.target_weight : 0;
      // Effective portfolio target %: class × intra-class when classified, else direct
      const targetWeight = cls ? (cls.target_weight * intraTgt) / 100 : intraTgt;
      const weight   = total > 0 && val != null ? (val / total) * 100 : null;
      const intraWeight = cls && classVals[cls.id] > 0 && val != null
        ? (val / classVals[cls.id]) * 100 : null;

      let buyShares = null;
      if (targetWeight > 0 && weight != null && px != null && px > 0) {
        const delta = targetWeight - weight;
        if (delta > 0.1) {
          const targetValue = (targetWeight / 100) * total;
          const toInvest = targetValue - val;
          if (toInvest > 0) buyShares = toInvest / px;
        }
      }

      return {
        ...h,
        avgCost: h.avg_cost,
        px,
        val,
        cost,
        ret,
        day,
        div,
        targetWeight,
        intraTgt,
        intraWeight,
        cls,
        weight,
        buyShares,
        name: q?.name || h.symbol,
        color: h.color || COLORS[i % COLORS.length],
      };
    });
  },
};

// ── CHART HELPERS ──────────────────────────────────────────────
Chart.defaults.color        = '#5a6680';
Chart.defaults.borderColor  = 'rgba(255,255,255,0.06)';
Chart.defaults.font.family  = "'JetBrains Mono',monospace";

const TT = { backgroundColor:'#0c1120', borderColor:'rgba(255,255,255,0.1)', borderWidth:1, padding:10 };

function lineGrad(ctx, isGain) {
  const g = ctx.chart.ctx.createLinearGradient(0, 0, 0, 240);
  g.addColorStop(0, isGain ? 'rgba(20,240,168,.15)' : 'rgba(240,72,110,.15)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  return g;
}

// Reuse chart instance with .update('none') to avoid destroy/recreate overhead.
// portChartIsGain is a module-level variable so the backgroundColor closure
// reflects the current gain state on each update.
function buildPortChart(labels, vals) {
  const isGain = !vals.length || vals[vals.length - 1] >= vals[0];
  const col    = isGain ? '#14f0a8' : '#f0486e';
  portChartIsGain = isGain;

  if (S.charts.port) {
    S.charts.port.data.labels                  = labels;
    S.charts.port.data.datasets[0].data        = vals;
    S.charts.port.data.datasets[0].borderColor = col;
    S.charts.port.update('none');
    return;
  }

  S.charts.port = new Chart($('c-portfolio'), {
    type: 'line',
    data: { labels, datasets: [{ data: vals, borderColor: col, borderWidth: 1.5, pointRadius: 0, fill: true, backgroundColor: ctx => lineGrad(ctx, portChartIsGain), tension: .35 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode:'index', intersect:false },
      plugins: { legend:{ display:false }, tooltip:{ ...TT, callbacks:{ label: c => ` ${f.$(c.parsed.y)}` } } },
      scales: {
        x: { grid:{ display:false }, ticks:{ maxTicksLimit:6, font:{ size:10 } } },
        y: { position:'right', grid:{ color:'rgba(255,255,255,0.04)' }, ticks:{ font:{ size:10 }, callback: v => f.$(v,0) } },
      },
    },
  });
}

function buildAllocChart(rows) {
  const data = [...rows].sort((a, b) => (b.val || 0) - (a.val || 0));

  if (S.charts.alloc) {
    S.charts.alloc.data.labels                       = data.map(d => d.symbol);
    S.charts.alloc.data.datasets[0].data             = data.map(d => d.val || 0);
    S.charts.alloc.data.datasets[0].backgroundColor  = data.map(d => d.color);
    S.charts.alloc.update('none');
    return;
  }

  S.charts.alloc = new Chart($('c-alloc'), {
    type: 'doughnut',
    data: { labels: data.map(d => d.symbol), datasets: [{ data: data.map(d => d.val || 0), backgroundColor: data.map(d => d.color), borderColor:'#060a14', borderWidth:2, hoverOffset:4 }] },
    options: {
      responsive:true, maintainAspectRatio:false, cutout:'65%',
      plugins: {
        legend: { position:'bottom', labels:{ padding:10, boxWidth:9, boxHeight:9, font:{ size:10 }, color:'#5a6680' } },
        tooltip: { ...TT, callbacks:{ label: c => {
          const total = c.dataset.data.reduce((a, b) => a + b, 0);
          return ` ${c.label}: ${f.$(c.raw)} (${f.num(c.raw / total * 100, 1)}%)`;
        } } },
      },
    },
  });
}

function buildCalcChart(labels, contrib, portfolio, divs) {
  if (S.charts.calc) {
    S.charts.calc.data.labels             = labels;
    S.charts.calc.data.datasets[0].data   = portfolio;
    S.charts.calc.data.datasets[1].data   = contrib;
    S.charts.calc.data.datasets[2].data   = divs;
    S.charts.calc.update('none');
    return;
  }

  S.charts.calc = new Chart($('c-calc'), {
    type: 'line',
    data: { labels, datasets: [
      { label:'Portfolio',   data:portfolio, borderColor:'#14f0a8', borderWidth:2,   pointRadius:0, fill:true, backgroundColor:'rgba(20,240,168,.07)', tension:.4 },
      { label:'Contributed', data:contrib,   borderColor:'#5b8af0', borderWidth:1.5, pointRadius:0, fill:false, borderDash:[4,4], tension:.4 },
      { label:'Dividends',   data:divs,      borderColor:'#f0c05b', borderWidth:1.5, pointRadius:0, fill:false, tension:.4 },
    ] },
    options: {
      responsive:true, maintainAspectRatio:false,
      interaction:{ mode:'index', intersect:false },
      plugins: {
        legend: { position:'bottom', labels:{ padding:14, boxWidth:9, boxHeight:9, font:{ size:10 } } },
        tooltip: { ...TT, callbacks:{ label: c => ` ${c.dataset.label}: ${f.$(c.parsed.y, 0)}` } },
      },
      scales: {
        x: { grid:{ display:false }, ticks:{ font:{ size:10 } } },
        y: { position:'right', grid:{ color:'rgba(255,255,255,0.04)' }, ticks:{ font:{ size:10 }, callback: v => f.compact(v) } },
      },
    },
  });
}

// ── RENDER ─────────────────────────────────────────────────────
function updateFolioPill() {
  const folio = S.portfolios.find(p => p.id === S.currentFolioId);
  $('fp-name').textContent = folio ? folio.name : 'No portfolio';
}

function renderDash() {
  $('dash-empty').style.display   = !S.currentFolioId ? 'flex'  : 'none';
  $('dash-content').style.display =  S.currentFolioId ? 'block' : 'none';
  if (!S.currentFolioId) return;

  const val  = Port.value();
  const cost = Port.cost();
  const dayG = Port.dayGainAbs();
  const allG = val - cost;
  const allPct = cost > 0 ? allG / cost * 100 : 0;
  const prevVal = val - dayG;
  const dayPct  = prevVal > 0 ? dayG / prevVal * 100 : 0;
  const gc = n => n >= 0 ? 'var(--gain)' : 'var(--loss)';

  const set = (id, txt, col) => { const el = $(id); if (!el) return; el.textContent = txt; if (col) el.style.color = col; };
  set('s-total',   f.$(val),             gc(allG));
  set('s-allgain', `${f.$(allG)} (${f.pct(allPct)})`, gc(allG));
  set('s-daygain', f.$(dayG),            gc(dayG));
  set('s-daypct',  f.pct(dayPct) + ' vs. yesterday',  gc(dayG));
  set('s-allpct',  f.pct(allPct),        gc(allG));
  set('s-cost',    f.$(cost));
  set('s-count',   `${S.positions.length} position${S.positions.length !== 1 ? 's' : ''}`);

  const lu = $('upd-time');
  if (lu) lu.textContent = `Updated ${new Date().toLocaleTimeString()}`;

  buildAllocChart(Port.rows());
}

function renderPositionRow(h, isClassed) {
  const allocCell = h.cls
    ? `${h.intraWeight != null ? f.pct(h.intraWeight, 1) : '—'} / ${h.intraTgt > 0 ? f.pct(h.intraTgt, 1) : '—'}
       <div style="font-size:10px;color:var(--muted)">= ${h.weight != null ? f.pct(h.weight, 1) : '—'} portfolio</div>
       ${h.buyShares && h.buyShares > 0.01 ? `<div style="font-size:10px;color:var(--muted)">Buy ~${h.buyShares >= 10 ? f.num(h.buyShares, 0) : f.num(h.buyShares, 2)} sh</div>` : ''}`
    : `${h.weight != null && h.targetWeight > 0
          ? `${f.pct(h.weight, 1)} / ${f.pct(h.targetWeight, 1)}`
          : h.targetWeight > 0
            ? `Target ${f.pct(h.targetWeight, 1)}`
            : '—'
      }${h.buyShares && h.buyShares > 0.01 ? `<div style="font-size:10px;color:var(--muted)">Buy ~${h.buyShares >= 10 ? f.num(h.buyShares, 0) : f.num(h.buyShares, 2)} sh</div>` : ''}`;
  return `
    <tr data-sym="${h.symbol}"${isClassed ? ' class="classed"' : ''}>
      <td>
        <div class="sym-cell">
          <div class="sym-badge" style="background:${h.color}1a;border:1px solid ${h.color}33;color:${h.color}">${h.symbol.slice(0,4)}</div>
          <div class="sym-info"><div class="sym">${h.symbol}</div><div class="name">${h.name}</div></div>
        </div>
      </td>
      <td class="mono col-shares">${f.num(h.shares, h.shares % 1 === 0 ? 0 : 4)}</td>
      <td class="mono col-avgcost" style="text-align:right">${f.$(h.avg_cost)}</td>
      <td class="mono" style="text-align:right">${f.$(h.px)}</td>
      <td class="mono" style="text-align:right">${f.$(h.val)}</td>
      <td style="text-align:right"><span class="badge ${h.day != null ? sign(h.day) : 'neu'}">${h.day != null ? f.pct(h.day) : '—'}</span></td>
      <td style="text-align:right">
        <div class="mono ${h.ret != null ? 'c-' + sign(h.ret) : 'c-muted'}">${h.ret != null ? f.pct(h.ret) : '—'}</div>
        <div class="mono" style="font-size:10px;color:var(--muted)">${f.$(h.val != null ? h.val - h.cost : null)}</div>
      </td>
      <td class="mono col-divyield" style="text-align:right;color:var(--muted)">${allocCell}</td>
    </tr>`;
}

function renderHoldings() {
  const tbody = $('holdings-body');
  if (!tbody) return;
  const rows = Port.rows();
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:40px;color:var(--muted)">No positions yet. Add them in Settings (⚙).</td></tr>`;
    return;
  }

  const sortFn = (a, b) => {
    const va = a[S.sortCol] ?? 0, vb = b[S.sortCol] ?? 0;
    return typeof va === 'string' ? va.localeCompare(vb) * S.sortDir : (va - vb) * S.sortDir;
  };

  if (!S.classes.length) {
    // No classes — flat table (zero regression from previous behaviour)
    rows.sort(sortFn);
    tbody.innerHTML = rows.map(h => renderPositionRow(h, false)).join('');
  } else {
    // Grouped by class
    const total      = rows.reduce((s, h) => s + (h.val || 0), 0);
    const ungrouped  = rows.filter(h => !h.cls).sort(sortFn);
    const html       = [];

    if (ungrouped.length) {
      html.push(`<tr class="class-header-row"><td colspan="8"><span class="class-name" style="color:var(--muted)">Ungrouped</span></td></tr>`);
      html.push(...ungrouped.map(h => renderPositionRow(h, false)));
    }

    for (const cls of S.classes) {
      const clsRows = rows.filter(h => h.cls?.id === cls.id).sort(sortFn);
      if (!clsRows.length) continue;
      const clsVal  = clsRows.reduce((s, h) => s + (h.val || 0), 0);
      const clsPct  = total > 0 ? (clsVal / total * 100) : 0;
      const clsDayG = clsRows.reduce((s, h) => {
        if (h.px == null || h.day == null) return s;
        const prev = h.px / (1 + h.day / 100);
        return s + (h.px - prev) * h.shares;
      }, 0);
      const underweight = cls.target_weight > 0 && clsPct < cls.target_weight - 0.1;
      const buyHint = underweight
        ? `<span style="font-size:10px;color:var(--muted);margin-left:8px">· Buy ~${f.$((cls.target_weight / 100) * total - clsVal, 0)}</span>`
        : '';
      html.push(`
        <tr class="class-header-row">
          <td colspan="8">
            <span class="class-badge" style="background:${cls.color || '#5a6680'}"></span>
            <span class="class-name">${cls.name}</span>
            <span class="mono" style="margin-left:16px;font-size:12px">${f.$(clsVal)}</span>
            <span style="margin-left:10px;font-size:11px;color:var(--muted)">${f.pct(clsPct, 1)} / ${f.pct(cls.target_weight, 1)} target</span>
            <span class="mono ${sign(clsDayG)}" style="margin-left:10px;font-size:11px">${f.$(clsDayG)}</span>
            ${buyHint}
          </td>
        </tr>`);
      html.push(...clsRows.map(h => renderPositionRow(h, true)));
    }

    tbody.innerHTML = html.join('');
  }

  tbody.querySelectorAll('tr[data-sym]').forEach(row =>
    row.addEventListener('click', () => openStock(row.dataset.sym))
  );
}

async function loadPortChart(period) {
  if (!S.positions.length) return;
  const days = { '1M':30, '3M':90, '6M':182, '1Y':365 }[period] || 30;
  const from = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];

  const allHist = {};
  for (const sym of S.positions.map(h => h.symbol)) {
    try {
      // API.historical caches by symbol — period switches reuse the same data
      const full = await API.historical(sym);
      allHist[sym] = full.filter(d => d.date >= from);
    } catch(e) {
      allHist[sym] = [];
    }
  }

  const sample = Object.values(allHist).find(a => a.length) || [];
  const dates  = sample.map(d => d.date);
  if (dates.length < 2) { buildPortChart(['Start','Now'], [Port.cost(), Port.value()]); return; }

  const vals   = dates.map(date => S.positions.reduce((sum, h) => {
    const e = (allHist[h.symbol] || []).find(d => d.date === date);
    return sum + (e ? e.close * h.shares : 0);
  }, 0));
  const labels = dates.map(d => new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month:'short', day:'numeric' }));
  buildPortChart(labels, vals);
}

// ── STOCK MODAL ────────────────────────────────────────────────
async function openStock(symbol) {
  $('stk-modal-title').textContent = symbol;
  $('stk-modal-body').innerHTML = '<div class="spinner-wrap"><div class="spinner"></div>Loading…</div>';
  $('ov-stock').classList.add('open');

  const q   = S.quotes[symbol];
  const h   = S.positions.find(p => p.symbol === symbol);
  const px  = q?.price ?? 0;
  const chg = q?.changesPercentage ?? 0;
  const val = px * (h?.shares ?? 0);
  const cost= (h?.avg_cost ?? 0) * (h?.shares ?? 0);
  const idx = S.positions.findIndex(p => p.symbol === symbol);
  const color = h?.color || COLORS[idx % COLORS.length];

  $('stk-modal-body').innerHTML = `
    <div class="stk-hdr">
      <div class="stk-icon" style="background:${color}1a;border:1px solid ${color}33;color:${color}">${symbol.slice(0,4)}</div>
      <div class="stk-name"><h2>${symbol}</h2><p>${q?.name ?? ''}</p></div>
      <div class="stk-price"><div class="price">${f.$(px)}</div><span class="badge ${sign(chg)}" style="float:right;margin-top:5px">${f.pct(chg)}</span></div>
    </div>
    <div class="metrics">
      <div class="metric"><div class="ml">Market Cap</div><div class="mv">${f.compact(q?.marketCap)}</div></div>
      <div class="metric"><div class="ml">P/E Ratio</div><div class="mv">${q?.pe ? f.num(q.pe, 1) : '—'}</div></div>
      <div class="metric"><div class="ml">52W Low</div><div class="mv">${f.$(q?.yearLow)}</div></div>
      <div class="metric"><div class="ml">52W High</div><div class="mv">${f.$(q?.yearHigh)}</div></div>
    </div>
    ${h ? `
    <div class="position">
      <div class="pos-item"><div class="pl">Shares</div><div class="pv">${f.num(h.shares, h.shares%1===0?0:4)}</div></div>
      <div class="pos-item"><div class="pl">Avg Cost</div><div class="pv">${f.$(h.avg_cost)}</div></div>
      <div class="pos-item"><div class="pl">Market Value</div><div class="pv">${f.$(val)}</div></div>
      <div class="pos-item"><div class="pl">Total Return</div><div class="pv c-${sign(val-cost)}">${f.$(val-cost)} (${f.pct(cost ? (val-cost)/cost*100 : 0)})</div></div>
    </div>` : ''}
    <div class="sec-title">Price History (1Y)</div>
    <div style="position:relative;height:180px;margin-bottom:22px">
      <canvas id="stk-chart"></canvas>
      <div id="stk-loading" class="spinner-wrap" style="position:absolute;inset:0"><div class="spinner"></div></div>
    </div>
    <div class="sec-title">Dividend History</div>
    <div id="stk-divs"><div class="spinner-wrap" style="padding:20px"><div class="spinner"></div></div></div>`;

  // Load chart — reuses cached history if available, no extra API call
  try {
    const hist = await API.historical(symbol);
    $('stk-loading')?.remove();
    if (hist.length) {
      const sliced = hist.slice(0, 252).reverse();
      const isGain = sliced[sliced.length-1].close >= sliced[0].close;
      if (S.charts.stock) S.charts.stock.destroy();
      S.charts.stock = new Chart($('stk-chart'), {
        type:'line',
        data:{ labels: sliced.map(d => new Date(d.date+'T00:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric'})), datasets:[{ data: sliced.map(d => d.close), borderColor: isGain?'#14f0a8':'#f0486e', borderWidth:1.5, pointRadius:0, fill:true, backgroundColor: ctx => lineGrad(ctx, isGain), tension:.35 }] },
        options:{ responsive:true, maintainAspectRatio:false, plugins:{ legend:{ display:false }, tooltip:{ ...TT, callbacks:{ label: c => ` ${f.$(c.parsed.y)}` } } }, scales:{ x:{ grid:{ display:false }, ticks:{ maxTicksLimit:5, font:{ size:9 } } }, y:{ position:'right', grid:{ color:'rgba(255,255,255,0.04)' }, ticks:{ font:{ size:9 }, callback: v => f.$(v,0) } } } },
      });
    }
  } catch(e) {
    const el = $('stk-loading');
    if (el) el.innerHTML = `<span style="color:var(--muted);font-size:12px">Chart unavailable: ${e.message}</span>`;
  }

  // Load dividends
  try {
    const divs = await API.dividends(symbol);
    const el = $('stk-divs');
    if (!el) return;
    el.innerHTML = divs.length
      ? `<div class="div-list">${divs.slice(0,8).map(d => `<div class="div-row"><span class="dr">${f.date(d.date)}</span><span>${d.label||'Cash Dividend'}</span><span class="da">${f.$(d.dividend)}/share</span></div>`).join('')}</div>`
      : `<p style="color:var(--muted);font-size:12px;text-align:center;padding:14px">No dividend history available</p>`;
  } catch(e) {
    const el = $('stk-divs');
    if (el) el.innerHTML = `<p style="color:var(--muted);font-size:12px;text-align:center;padding:14px">${e.message.includes('limit') ? 'API rate limit reached' : `Could not load dividends: ${e.message}`}</p>`;
  }
}

// ── CALCULATOR ─────────────────────────────────────────────────
function runCalc() {
  const start   = parseFloat($('c-start').value)   || 0;
  const monthly = parseFloat($('c-monthly').value) || 0;
  const annRet  = parseFloat($('c-return').value)  || 0;
  const annDiv  = parseFloat($('c-div').value)     || 0;
  const years   = parseInt($('c-years').value)     || 20;
  const mRet = annRet / 100 / 12;
  const mDiv = annDiv / 100 / 12;
  let port = start, contrib = start, divTotal = 0;
  const labels = [], portVals = [], contribVals = [], divVals = [];
  for (let m = 0; m <= years * 12; m++) {
    if (m > 0) {
      port += monthly; contrib += monthly;
      const d = port * mDiv; divTotal += d;
      if (S.drip) port += d;
      port *= (1 + mRet);
    }
    if (m % 12 === 0) {
      const yr = m / 12;
      labels.push(yr === 0 ? 'Now' : `Yr ${yr}`);
      portVals.push(Math.round(port));
      contribVals.push(Math.round(contrib));
      divVals.push(Math.round(divTotal));
    }
  }
  const final = portVals[portVals.length - 1];
  $('r-final').textContent   = f.$(final, 0);
  $('r-contrib').textContent = f.$(contrib, 0);
  $('r-returns').textContent = f.$(final - contrib, 0);
  $('r-divs').textContent    = f.$(divTotal, 0);
  buildCalcChart(labels, contribVals, portVals, divVals);
}

// Debounced version used for input events — avoids running calc on every keystroke
function scheduleCalc() {
  clearTimeout(_calcTimer);
  _calcTimer = setTimeout(runCalc, 300);
}

// ── FOLIO MANAGEMENT ───────────────────────────────────────────
async function openFolioModal() {
  $('ov-folio').classList.add('open');
  await renderFolioList();
}

async function renderFolioList() {
  const list = $('folio-list');
  list.innerHTML = '<div class="spinner-wrap" style="padding:16px"><div class="spinner"></div></div>';
  try {
    S.portfolios = await DB.listPortfolios();
    if (!S.portfolios.length) {
      list.innerHTML = '<p style="color:var(--muted);font-size:13px;text-align:center;padding:20px">No portfolios yet. Create one below.</p>';
      return;
    }
    list.innerHTML = S.portfolios.map(p => `
      <div class="folio-item ${p.id === S.currentFolioId ? 'active' : ''}" data-id="${p.id}">
        <div>
          <div class="fi-name">${p.name}</div>
          <div class="fi-meta">Created ${new Date(p.created_at).toLocaleDateString()}</div>
        </div>
        <div class="folio-actions">
          ${p.id !== S.currentFolioId
            ? `<button class="btn btn-sm folio-select" data-id="${p.id}">Select</button>`
            : '<span style="font-size:11px;color:var(--accent);font-weight:600">Active</span>'}
          <button class="btn btn-sm btn-danger folio-delete" data-id="${p.id}" data-name="${p.name.replace(/"/g, '&quot;')}">Delete</button>
        </div>
      </div>`).join('');

    // Event delegation — no global window._ functions needed
    list.querySelectorAll('.folio-actions').forEach(el =>
      el.addEventListener('click', e => e.stopPropagation())
    );
    list.querySelectorAll('.folio-select').forEach(btn =>
      btn.addEventListener('click', () => selectFolio(btn.dataset.id))
    );
    list.querySelectorAll('.folio-delete').forEach(btn =>
      btn.addEventListener('click', () => deleteFolio(btn.dataset.id, btn.dataset.name))
    );
  } catch(e) {
    list.innerHTML = `<p style="color:var(--loss);font-size:13px;padding:16px">Error: ${e.message}</p>`;
  }
}

function selectFolio(id) {
  S.currentFolioId = id;
  localStorage.setItem('folio_current_id', id);
  closeOverlay('ov-folio');
  updateFolioPill();
  loadAll();
  toast(`Switched to: ${S.portfolios.find(p => p.id === id)?.name || id}`);
}

async function deleteFolio(id, name) {
  if (!confirm(`Delete portfolio "${name}" and all its positions? This cannot be undone.`)) return;
  try {
    await DB.deletePortfolio(id);
    if (S.currentFolioId === id) {
      S.currentFolioId = null; S.positions = [];
      localStorage.removeItem('folio_current_id');
      updateFolioPill(); renderDash(); renderHoldings();
    }
    toast('Portfolio deleted');
    await renderFolioList();
  } catch(e) { /* already handled in DB layer */ }
}

// ── CREATE PORTFOLIO MODAL ──────────────────────────────────────
function openCreateFolioModal() {
  const nameInput = $('new-folio-name');
  nameInput.value = '';
  nameInput.classList.remove('error');
  $('ov-create-folio').classList.add('open');
  setTimeout(() => nameInput.focus(), 50);
}

async function confirmCreateFolio() {
  const nameInput = $('new-folio-name');
  const name = nameInput.value.trim();
  const btn = $('confirm-create-folio');

  if (!name) {
    nameInput.classList.add('error');
    nameInput.focus();
    return;
  }

  if (name.length > 50) {
    toast('Portfolio name too long (max 50 characters)', 'error');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Creating…';
  try {
    const folio = await DB.createPortfolio(name);
    S.portfolios.push(folio);
    S.currentFolioId = folio.id;
    S.positions = [];
    localStorage.setItem('folio_current_id', folio.id);
    closeOverlay('ov-create-folio');
    closeOverlay('ov-folio');
    updateFolioPill();
    renderDash();
    renderHoldings();
    toast(`Created: ${folio.name}`);
  } catch (e) {
    // Error already surfaced by handleDbError in DB layer
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create';
  }
}

// ── SETTINGS ──────────────────────────────────────────────────
function openSettings() {
  const avInput = $('set-avkey');
  if (avInput) {
    avInput.value = '';
    avInput.placeholder = S.avKey
      ? 'Key already saved — paste a new key to replace it'
      : 'Paste your Alpha Vantage API key…';
  }
  const fhInput = $('set-fhkey');
  if (fhInput) {
    fhInput.value = '';
    fhInput.placeholder = S.fhKey
      ? 'Key already saved — paste a new key to replace it'
      : 'Paste your Finnhub API key…';
  }
  const folio = S.portfolios.find(p => p.id === S.currentFolioId);
  $('settings-folio-name').textContent = folio ? `— ${folio.name}` : '';
  editorClasses     = S.classes.map(c => ({ ...c }));
  _originalClassIds = S.classes.map(c => c.id);
  _deletedClassIds  = [];
  editorRows = S.positions.map(p => ({ ...p }));
  renderClassEditor();
  renderEditor();
  $('ov-settings').classList.add('open');
}

function syncEditorRowsFromDOM() {
  document.querySelectorAll('#h-editor .h-row').forEach((r, i) => {
    if (!editorRows[i]) return;
    editorRows[i].symbol        = r.querySelector('.hs')?.value.trim().toUpperCase() || '';
    editorRows[i].shares        = parseFloat(r.querySelector('.hq')?.value) || 0;
    editorRows[i].avg_cost      = parseFloat(r.querySelector('.hc')?.value) || 0;
    editorRows[i].target_weight = parseFloat(r.querySelector('.ht')?.value) || 0;
    editorRows[i].class_id      = r.querySelector('.hcls')?.value || null;
  });
}

function renderClassEditor() {
  const section = $('classes-section');
  if (!section) return;
  const sum   = editorClasses.reduce((s, c) => s + (c.target_weight || 0), 0);
  const sumOk = editorClasses.length === 0 || Math.abs(sum - 100) < 0.01 || sum === 0;
  section.innerHTML = `
    <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:${editorClasses.length ? '8px' : '0'}">
      ${editorClasses.map((cls, i) => `
        <div class="class-pill" data-i="${i}">
          <span class="class-badge" style="background:${cls.color || COLORS[i % COLORS.length]}"></span>
          <input type="text" class="cp-name" placeholder="Name" value="${(cls.name || '').replace(/"/g, '&quot;')}" maxlength="50">
          <input type="number" class="cp-tw" placeholder="0" value="${cls.target_weight}" min="0" max="100" step="0.1">
          <span style="font-size:11px;color:var(--muted)">%</span>
          <button class="rm-btn cp-del" style="width:24px;height:24px;font-size:14px" data-i="${i}">×</button>
        </div>`).join('')}
    </div>
    ${editorClasses.length ? `<div class="class-weight-sum ${sumOk ? 'ok' : 'bad'}">Class weights: ${f.num(sum, 1)}% / 100%</div>` : ''}`;

  section.querySelectorAll('.class-pill').forEach(pill => {
    const i = parseInt(pill.dataset.i, 10);
    pill.querySelector('.cp-name').addEventListener('input', e => {
      editorClasses[i].name = e.target.value;
    });
    pill.querySelector('.cp-tw').addEventListener('input', e => {
      editorClasses[i].target_weight = parseFloat(e.target.value) || 0;
      const newSum = editorClasses.reduce((s, c) => s + (c.target_weight || 0), 0);
      const newOk  = editorClasses.length === 0 || Math.abs(newSum - 100) < 0.01 || newSum === 0;
      const sumEl  = section.querySelector('.class-weight-sum');
      if (sumEl) { sumEl.textContent = `Class weights: ${f.num(newSum, 1)}% / 100%`; sumEl.className = `class-weight-sum ${newOk ? 'ok' : 'bad'}`; }
    });
    pill.querySelector('.cp-del').addEventListener('click', () => {
      syncEditorRowsFromDOM();
      const cls = editorClasses[i];
      const posInClass = editorRows.filter(r => r.class_id === cls.id).length;
      if (posInClass > 0 && !confirm(`Remove class "${cls.name}"? ${posInClass} position(s) will become ungrouped.`)) return;
      if (_originalClassIds.includes(cls.id)) _deletedClassIds.push(cls.id);
      editorRows.forEach(r => { if (r.class_id === cls.id) r.class_id = null; });
      editorClasses.splice(i, 1);
      renderClassEditor();
      renderEditor();
    });
  });
}

function renderEditor() {
  const ed = $('h-editor');
  if (!ed) return;
  ed.innerHTML = editorRows.map((h, i) => `
    <div class="h-row" data-i="${i}">
      <input type="text" class="hs" placeholder="AAPL" value="${h.symbol}" style="text-transform:uppercase">
      <input type="number" class="hq" placeholder="Shares" value="${h.shares}" min="0" step="any">
      <input type="number" class="hc" placeholder="Avg $" value="${h.avg_cost}" min="0" step="any">
      <input type="number" class="ht" placeholder="10" value="${typeof h.target_weight === 'number' ? h.target_weight : 0}" min="0" max="100" step="0.1" title="Direct portfolio % (ungrouped) or intra-class % (when assigned to a class)">
      <select class="hcls">
        <option value="">— None —</option>
        ${editorClasses.map(c => `<option value="${c.id}" ${h.class_id === c.id ? 'selected' : ''}>${c.name || 'Unnamed'}</option>`).join('')}
      </select>
      <button class="rm-btn" data-sym="${h.symbol}">×</button>
    </div>`).join('');

  ed.querySelectorAll('.rm-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const rowEl = btn.closest('.h-row');
      const idx = rowEl ? parseInt(rowEl.dataset.i, 10) : -1;
      const sym = btn.dataset.sym;

      if (!sym) {
        if (idx >= 0) { editorRows.splice(idx, 1); renderEditor(); }
        else rowEl?.remove();
        return;
      }

      if (!S.currentFolioId) { rowEl?.remove(); return; }

      try {
        await DB.deletePosition(S.currentFolioId, sym);
        editorRows = editorRows.filter(p => p.symbol !== sym);
        S.positions = S.positions.filter(p => p.symbol !== sym);
        renderEditor();
        loadAll();
        toast(`Removed ${sym}`);
      } catch(e) { /* already handled */ }
    });
  });
}

async function saveSettings() {
  const avKeyInput = $('set-avkey')?.value.trim();
  if (avKeyInput) { S.avKey = avKeyInput; localStorage.setItem('folio_av_key', avKeyInput); }

  const fhKeyInput = $('set-fhkey')?.value.trim();
  if (fhKeyInput) { S.fhKey = fhKeyInput; localStorage.setItem('folio_fh_key', fhKeyInput); }

  if (!S.currentFolioId) { closeOverlay('ov-settings'); return; }

  // Validate class target weight sum
  const classSum = editorClasses.reduce((s, c) => s + (c.target_weight || 0), 0);
  if (editorClasses.length > 0 && classSum > 0 && Math.abs(classSum - 100) > 0.1) {
    toast(`Class weights sum to ${f.num(classSum, 1)}% — must equal 100%.`, 'error');
    return;
  }

  // Parse position rows from DOM
  const domRows = document.querySelectorAll('#h-editor .h-row');
  const posData = [];
  editorRows = [];
  let ungroupedTargetSum = 0;
  const classIntraSums = {};

  domRows.forEach((r, i) => {
    const sym     = r.querySelector('.hs').value.trim().toUpperCase();
    const shares  = parseFloat(r.querySelector('.hq').value);
    const cost    = parseFloat(r.querySelector('.hc').value);
    const target  = parseFloat(r.querySelector('.ht').value);
    const classId = r.querySelector('.hcls')?.value || null;
    if (sym && shares > 0 && cost >= 0) {
      const existing = S.positions.find(p => p.symbol === sym);
      const color    = existing?.color || COLORS[i % COLORS.length];
      const tw       = isNaN(target) ? 0 : target;
      if (classId) {
        classIntraSums[classId] = (classIntraSums[classId] || 0) + tw;
      } else {
        ungroupedTargetSum += tw;
      }
      editorRows.push({ symbol: sym, shares, avg_cost: cost, folio_id: S.currentFolioId, color, target_weight: tw, class_id: classId || null });
      posData.push({ sym, shares, cost, color, tw, classId: classId || null });
    }
  });

  // Validate intra-class weight sums
  for (const [clsId, sum] of Object.entries(classIntraSums)) {
    if (sum > 0 && Math.abs(sum - 100) > 0.1) {
      const cls = editorClasses.find(c => c.id === clsId);
      toast(`Class "${cls?.name || 'Unnamed'}" weights sum to ${f.num(sum, 1)}% — must equal 100%.`, 'error');
      return;
    }
  }

  // Validate ungrouped position target weights (existing behaviour)
  if (ungroupedTargetSum > 0 && Math.abs(ungroupedTargetSum - 100) > 0.1) {
    toast('Ungrouped position target weights must sum to 100% when set.', 'error');
    return;
  }

  try {
    // Upsert classes first (positions reference them by class_id)
    for (let i = 0; i < editorClasses.length; i++) {
      const c = editorClasses[i];
      await DB.upsertClass(S.currentFolioId, {
        id: c.id, name: c.name || 'Unnamed', targetWeight: c.target_weight || 0,
        color: c.color, sortOrder: i,
      });
    }
    // Delete removed classes (ON DELETE SET NULL keeps positions, unassigns class_id)
    for (const id of _deletedClassIds) await DB.deleteClass(id);

    // Upsert positions
    await Promise.all(posData.map(p =>
      DB.upsertPosition(S.currentFolioId, p.sym, p.shares, p.cost, p.color, p.tw, p.classId)
    ));
    S.positions   = await DB.listPositions(S.currentFolioId);
    S.classes     = await DB.listClasses(S.currentFolioId);
    editorRows    = S.positions.map(p => ({ ...p }));
    editorClasses = S.classes.map(c => ({ ...c }));
    closeOverlay('ov-settings');
    toast('Positions saved');
    loadAll();
  } catch(e) { /* already handled */ }
}

// ── EXPORT / IMPORT ────────────────────────────────────────────
function exportJSON() {
  const folio = S.portfolios.find(p => p.id === S.currentFolioId);
  const blob  = new Blob([JSON.stringify({ folio: folio?.name || 'Unknown', positions: S.positions, exportedAt: new Date().toISOString() }, null, 2)], { type:'application/json' });
  const a     = document.createElement('a');
  a.href      = URL.createObjectURL(blob);
  a.download  = `folio-${(folio?.name||'export').replace(/\s/g,'-')}-${new Date().toISOString().split('T')[0]}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('Exported');
}

async function importJSON(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.positions)) throw new Error('Invalid file format');
    if (!confirm(`Import ${data.positions.length} positions into a new portfolio "${data.folio || 'Imported'}"?`)) return;
    const folio = await DB.createPortfolio(data.folio || 'Imported');
    for (const p of data.positions)
      await DB.upsertPosition(folio.id, p.symbol, p.shares, p.avg_cost ?? p.avgCost ?? 0, p.color);
    S.portfolios.push(folio);
    S.currentFolioId = folio.id;
    localStorage.setItem('folio_current_id', folio.id);
    updateFolioPill();
    await loadAll();
    toast('Import complete: ' + folio.name);
  } catch(e) { toast('Import failed: ' + e.message, 'error'); }
}

// ── OVERLAY HELPERS ────────────────────────────────────────────
function closeOverlay(id) {
  $(id)?.classList.remove('open');
  if (id === 'ov-stock' && S.charts.stock) { S.charts.stock.destroy(); S.charts.stock = null; }
}

// ── LOAD ALL ───────────────────────────────────────────────────
async function loadAll() {
  if (!S.currentFolioId) { S.classes = []; renderDash(); renderHoldings(); return; }
  try {
    S.positions = await DB.listPositions(S.currentFolioId);
  } catch(e) { return; }
  try {
    S.classes = await DB.listClasses(S.currentFolioId);
  } catch(e) {
    S.classes = [];
    console.warn('[FOLIO] Classes unavailable:', e.message);
  }

  renderDash(); renderHoldings();

  const syms = S.positions.map(h => h.symbol);
  if (!syms.length) return;

  const tbody = $('holdings-body');

  // Step 1: try shared DB cache for all symbols (fast, single query)
  try {
    const { data: rows } = await S.db
      .from('quotes')
      .select('*')
      .in('symbol', syms);

    if (rows && rows.length) {
      rows.forEach(r => {
        S.quotes[r.symbol] = {
          symbol:            r.symbol,
          name:              r.name || r.symbol,
          price:             r.price ?? null,
          change:            r.change ?? 0,
          changesPercentage: r.changes_percentage ?? 0,
          marketCap:         r.market_cap || null,
          pe:                r.pe || null,
          yearHigh:          r.year_high ?? null,
          yearLow:           r.year_low ?? null,
          dividendYield:     r.dividend_yield ?? 0,
        };
        Cache.set('q1_' + r.symbol, S.quotes[r.symbol], CACHE_Q);
      });
      renderDash();
      renderHoldings();
    }
  } catch(e) {
    // Non-fatal: fall through to API path
  }

  if (tbody) tbody.innerHTML = `<tr><td colspan="8"><div class="spinner-wrap"><div class="spinner"></div>Fetching quotes…</div></td></tr>`;

  try {
    const qs = await API.quotes(syms);
    qs.forEach(q => { S.quotes[q.symbol] = q; });
    renderDash(); renderHoldings();
    const total = Port.value();
    if (total > 0) $('c-start').value = Math.round(total);
    runCalc();
    loadPortChart(S.period).catch(e => console.warn('Port chart:', e.message));
  } catch(e) {
    if (tbody) tbody.innerHTML = `
      <tr><td colspan="8">
        <div style="text-align:center;padding:40px">
          <div style="font-size:32px;margin-bottom:12px">⚠️</div>
          <div style="font-weight:600;margin-bottom:6px">Failed to load quotes</div>
          <div style="color:var(--muted);font-size:13px;margin-bottom:16px">${e.message}</div>
          <button class="btn btn-primary" onclick="loadAll()">Retry</button>
        </div>
      </td></tr>`;
    toast(e.message, 'error');
  }
}

// ── EVENTS ────────────────────────────────────────────────────
function initEvents() {
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      btn.classList.add('active');
      $('tab-' + btn.dataset.tab)?.classList.add('active');
      if (btn.dataset.tab === 'calculator') runCalc();
    });
  });

  document.querySelectorAll('.period-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      S.period = btn.dataset.p;
      loadPortChart(S.period);
    });
  });

  document.querySelectorAll('thead th[data-s]').forEach(th => {
    th.addEventListener('click', () => {
      S.sortDir = S.sortCol === th.dataset.s ? S.sortDir * -1 : -1;
      S.sortCol = th.dataset.s;
      renderHoldings();
    });
  });

  $('folio-pill')?.addEventListener('click', openFolioModal);
  $('btn-refresh')?.addEventListener('click', () => { Cache.clearQuotes(); loadAll(); });
  $('btn-settings')?.addEventListener('click', openSettings);
  $('btn-add-pos')?.addEventListener('click', openSettings);
  $('dash-create-btn')?.addEventListener('click', openFolioModal);
  $('btn-create-folio')?.addEventListener('click', openCreateFolioModal);
  $('confirm-create-folio')?.addEventListener('click', confirmCreateFolio);

  $('new-folio-name')?.addEventListener('input', function() { this.classList.remove('error'); });
  $('new-folio-name')?.addEventListener('keypress', function(e) { if (e.key === 'Enter') confirmCreateFolio(); });

  $('save-settings')?.addEventListener('click', saveSettings);
  $('add-holding')?.addEventListener('click', () => {
    syncEditorRowsFromDOM();
    editorRows.push({ symbol:'', shares:0, avg_cost:0, folio_id:S.currentFolioId, color:null, target_weight:0, class_id:null });
    renderEditor();
  });

  $('add-class')?.addEventListener('click', () => {
    syncEditorRowsFromDOM();
    editorClasses.push({
      id:            crypto.randomUUID(),
      folio_id:      S.currentFolioId,
      name:          '',
      target_weight: 0,
      color:         COLORS[editorClasses.length % COLORS.length],
      sort_order:    editorClasses.length,
    });
    renderClassEditor();
    renderEditor();
  });

  $('btn-logout')?.addEventListener('click', async () => {
    await S.db.auth.signOut();
    localStorage.removeItem('folio_current_id');
    window.location.href = '/';
  });

  $('btn-export')?.addEventListener('click', exportJSON);
  $('btn-import')?.addEventListener('click', () => $('import-file').click());
  $('import-file')?.addEventListener('change', e => { if (e.target.files[0]) importJSON(e.target.files[0]); });
  $('btn-clear-cache')?.addEventListener('click', Cache.clearQuotes);

  $('btn-calc')?.addEventListener('click', runCalc);
  ['c-start','c-monthly','c-return','c-div','c-years'].forEach(id =>
    $(id)?.addEventListener('input', scheduleCalc)
  );
  $('drip-toggle')?.addEventListener('click', e => {
    S.drip = !S.drip;
    e.currentTarget.classList.toggle('on', S.drip);
    runCalc();
  });

  document.querySelectorAll('[data-close]').forEach(btn =>
    btn.addEventListener('click', () => closeOverlay(btn.dataset.close))
  );
  document.querySelectorAll('.overlay').forEach(ov =>
    ov.addEventListener('click', e => { if (e.target === ov) closeOverlay(ov.id); })
  );
}

// ── INIT ─────────────────────────────────────────────────────
async function init() {
  initDB();
  initEvents();

  const { data: { session } } = await S.db.auth.getSession();
  if (!session) { window.location.href = '/auth.html'; return; }
  S.user = session.user;

  S.avKey = avKey || localStorage.getItem('folio_av_key') || '';
  S.fhKey = fhKey || localStorage.getItem('folio_fh_key') || '';
  if (avKey) localStorage.setItem('folio_av_key', avKey);
  if (fhKey) localStorage.setItem('folio_fh_key', fhKey);

  $('app-shell').style.display = 'block';

  try {
    S.portfolios = await DB.listPortfolios();
  } catch(e) {
    toast('Could not load portfolios: ' + e.message, 'error');
    return;
  }

  if (S.currentFolioId && !S.portfolios.find(p => p.id === S.currentFolioId)) {
    S.currentFolioId = null;
    localStorage.removeItem('folio_current_id');
  }

  if (!S.currentFolioId && S.portfolios.length) {
    S.currentFolioId = S.portfolios[0].id;
    localStorage.setItem('folio_current_id', S.currentFolioId);
  }

  updateFolioPill();
  runCalc();
  await loadAll();

  if (!S.portfolios.length)
    toast('Welcome to FOLIO! Create your first portfolio to get started.', 'info');

  S.db.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') {
      localStorage.removeItem('folio_current_id');
      window.location.href = '/';
    }
  });
}

init();
