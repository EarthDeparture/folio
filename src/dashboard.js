import { Chart, registerables } from 'chart.js';
import { createClient } from '@supabase/supabase-js';

Chart.register(...registerables);

// ═══════════════════════════════════════════════════════════════
// DIVIDND · Dashboard
// Auth: Supabase RLS — all ownership enforced at DB level via
//       auth.uid(). No browser_id. JWT auto-attached by client.
// ═══════════════════════════════════════════════════════════════

// ── CONFIG ─────────────────────────────────────────────────────
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || '';
const sbKey        = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

const CACHE_Q = 24 * 60 * 60 * 1000;  // 24 h — quote TTL
const CACHE_H = 24 * 60 * 60 * 1000;  // 24 h — history TTL

// ── STATE ──────────────────────────────────────────────────────
const S = {
  db:             null,
  user:           null,
  portfolios:     [],
  currentFolioId: localStorage.getItem('dividnd_current_id') || null,
  positions:      [],
  classes:        [],
  quotes:         {},
  period:         '1M',
  sortCol:        'value',
  sortDir:        -1,
  drip:           true,
  charts:         { port: null, alloc: null, calc: null, stock: null, bench: null, posReturns: null, rolling: null, drip: null },
  currency:       localStorage.getItem('dividnd_currency') || 'USD',
  fxRate:         1.0,
  showCombined:   localStorage.getItem('dividnd_combined') === 'true',
  allPositions:   [],
  plan:           'free',
};

const FREE_LIMITS = { portfolios: 1, positions: 5 };
const isPremium = () => S.plan === 'premium';

function getLimitsRemaining() {
  const portRem = Math.max(0, FREE_LIMITS.portfolios - S.portfolios.length);
  const posRem  = Math.max(0, FREE_LIMITS.positions  - S.positions.length);
  return { portRem, posRem };
}

function updateLimitsDisplay() {
  const el = $('pos-remaining');
  if (isPremium()) {
    if (el) el.textContent = '';
    return;
  }
  const { posRem } = getLimitsRemaining();
  if (el) {
    if (posRem === 0) {
      el.textContent = '(limit reached)';
      el.style.color = 'var(--loss)';
    } else if (posRem <= 2) {
      el.textContent = `(${posRem} left)`;
      el.style.color = 'var(--loss)';
    } else {
      el.textContent = `(${posRem} remaining)`;
      el.style.color = 'var(--muted)';
    }
  }
}

// Separate editor state so Settings edits do not mutate live positions
let editorRows = [];
let editorClasses = [];
let _deletedClassIds = [];
let _originalClassIds = [];

// Track gain state for port chart gradient closure
let portChartIsGain  = true;
let _portChartStyle  = 'line'; // 'line' | 'bar'

// Debounce handles for calculator and rebalance
let _calcTimer = null;
let _rebTimer  = null;

// Stats tab state
let _statsPeriod    = 'YTD';
let _benchmarkSym   = 'SPY';
const BENCH_LABELS  = { 'SPY':'S&P 500 (SPY)', 'QQQ':'Nasdaq 100 (QQQ)', 'VTI':'Total Market (VTI)', 'GLD':'Gold (GLD)', 'BTC-USD':'Bitcoin (BTC)' };
let _statsHistCache = null;   // { SYM: [{date,close},...], benchmark: [...] }
let _divCalMonth    = new Date().getMonth();
let _divCalYear     = new Date().getFullYear();
let _divHistCache    = null;   // { SYM: [{date,dividend},...] }
let _overviewFetched = new Set(); // symbols whose OVERVIEW has been requested this session
let _watchlist    = [];         // [{ id, symbol, note, target_price }]
let _alertedSyms  = new Set(); // symbols toasted this session (prevents repeat)

// Trade modal state
let _tradeModalSymbol = null;
let _tradeTimer       = null;
let _editingTradeId   = null;

const COLORS = [
  '#14f0a8','#5b8af0','#f05b8a','#f0c05b','#a05bf0',
  '#5be8f0','#f0905b','#8af05b','#c05bf0','#f05b5b',
  '#5bd4f0','#f0d65b','#5bf0c0','#e05bf0','#90f05b',
  '#5b90f0','#f0a05b','#5bf080','#f07a5b','#a0c05b',
];

// ── HELPERS ────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

// HTML-escape user-controlled strings before inserting into innerHTML
const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#x27;');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const f = {
  $:   (n, d = 2) => n == null ? '—' : new Intl.NumberFormat('en-US', { style:'currency', currency:'USD', minimumFractionDigits:d, maximumFractionDigits:d }).format(n),
  pct: (n, d = 2) => n == null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(d)}%`,
  num: (n, d = 0) => n == null ? '—' : n.toFixed(d),
  compact: n => n == null ? '—' : new Intl.NumberFormat('en-US', { notation:'compact', maximumFractionDigits:1 }).format(n),
  date: s => new Date(s + 'T00:00:00').toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' }),
};

const sign = n => n >= 0 ? 'gain' : 'loss';

// ── FX RATE ────────────────────────────────────────────────────
async function fetchFxRate() {
  const cached = Cache.get('fx_usd_cad');
  if (cached) { S.fxRate = cached; return; }
  try {
    const r = await fetch('https://open.er-api.com/v6/latest/USD');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    const rate = d?.rates?.CAD;
    if (rate) {
      S.fxRate = rate;
      Cache.set('fx_usd_cad', rate, 24 * 60 * 60 * 1000);
    }
  } catch(e) {
    console.warn('[DIVIDND] FX rate fetch failed:', e.message);
  }
}

// ── TOAST ──────────────────────────────────────────────────────
function toast(msg, type = 'success') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('toast-container').appendChild(el);
  const duration = type === 'error' ? 8000 : 3500;
  setTimeout(() => {
    el.style.transition = 'opacity .25s, transform .25s';
    el.style.opacity = '0';
    el.style.transform = 'translateX(12px)';
    setTimeout(() => el.remove(), 260);
  }, duration);
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


function handleDbError(error, context = '') {
  if (isPermissionDenied(error)) {
    console.error(`[DIVIDND] Permission denied — ${context} | user: ${S.user?.id}`, error);
    toast('Permission denied. Please sign out and sign back in.', 'error');
    return;
  }
  console.error(`[DIVIDND] DB error — ${context}`, error);
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
    try { localStorage.setItem('dividnd_c_' + k, JSON.stringify({ d, exp: Date.now() + ttl })); } catch(e) {}
  },
  get(k) {
    try {
      const c = JSON.parse(localStorage.getItem('dividnd_c_' + k));
      if (c && Date.now() < c.exp) return c.d;
    } catch {}
    return null;
  },
  clearQuotes() {
    Object.keys(localStorage)
      .filter(k => k.startsWith('dividnd_c_q1_') || k.startsWith('dividnd_c_h_') || k.startsWith('dividnd_c_div_'))
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

  async upsertPosition(folioId, symbol, shares, avgCost, color, targetWeight, classId = null, targetPrice = null) {
    const payload = {
      folio_id:      folioId,
      symbol:        symbol.toUpperCase(),
      shares,
      avg_cost:      avgCost,
      color,
      target_weight: targetWeight ?? 0,
      class_id:      classId || null,
      updated_at:    new Date().toISOString(),
    };
    if (targetPrice != null) payload.target_price = targetPrice;
    const { data, error } = await S.db
      .from('positions')
      .upsert(payload, { onConflict: 'folio_id,symbol' })
      .select().single();
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

  async insertTrade(folioId, symbol, type, shares, price, tradedAt) {
    const { data, error } = await S.db
      .from('trades')
      .insert({ folio_id: folioId, symbol: symbol.toUpperCase(), type, shares, price, traded_at: tradedAt })
      .select().single();
    if (error) { handleDbError(error, `insertTrade ${symbol}`); throw error; }
    return data;
  },

  async listTrades(folioId, symbol) {
    const { data, error } = await S.db
      .from('trades').select('*')
      .eq('folio_id', folioId).eq('symbol', symbol.toUpperCase())
      .order('traded_at', { ascending: false }).limit(50);
    if (error) { handleDbError(error, `listTrades ${symbol}`); throw error; }
    return data || [];
  },

  async listTradesAsc(folioId, symbol) {
    const { data, error } = await S.db
      .from('trades').select('*')
      .eq('folio_id', folioId).eq('symbol', symbol.toUpperCase())
      .order('traded_at', { ascending: true })
      .order('created_at', { ascending: true });
    if (error) { handleDbError(error, `listTradesAsc ${symbol}`); throw error; }
    return data || [];
  },

  async updateTrade(id, type, shares, price, tradedAt) {
    const { error } = await S.db
      .from('trades').update({ type, shares, price, traded_at: tradedAt }).eq('id', id);
    if (error) { handleDbError(error, `updateTrade ${id}`); throw error; }
  },

  async deleteTrade(id) {
    const { error } = await S.db.from('trades').delete().eq('id', id);
    if (error) { handleDbError(error, `deleteTrade ${id}`); throw error; }
  },

  async listWatchlist() {
    const { data, error } = await S.db.from('watchlist').select('*').order('created_at', { ascending: false });
    if (error) { handleDbError(error, 'listWatchlist'); return []; }
    return data || [];
  },
  async addWatchlist(symbol) {
    const { data, error } = await S.db.from('watchlist').insert({ user_id: S.user.id, symbol: symbol.toUpperCase() }).select().single();
    if (error) { handleDbError(error, 'addWatchlist'); throw error; }
    return data;
  },
  async removeWatchlist(id) {
    const { error } = await S.db.from('watchlist').delete().eq('id', id);
    if (error) handleDbError(error, 'removeWatchlist');
  },
  async updateWatchlistTarget(id, targetPrice) {
    const { error } = await S.db.from('watchlist').update({ target_price: targetPrice || null }).eq('id', id);
    if (error) handleDbError(error, 'updateWatchlistTarget');
  },

  async recalcPositionFromTrades(folioId, symbol) {
    const trades = await this.listTradesAsc(folioId, symbol);
    const pos    = S.positions.find(p => p.symbol === symbol);
    let shares = 0, avgCost = 0;
    for (const t of trades) {
      if (t.type === 'buy') {
        const newShares = shares + Number(t.shares);
        avgCost = shares > 0
          ? ((shares * avgCost) + (Number(t.shares) * Number(t.price))) / newShares
          : Number(t.price);
        shares = newShares;
      } else {
        shares = Math.max(0, shares - Number(t.shares));
      }
    }
    if (shares <= 0.0001) {
      try { await this.deletePosition(folioId, symbol); } catch(e) { /* already gone */ }
    } else {
      await this.upsertPosition(folioId, symbol, shares, avgCost,
        pos?.color || null, pos?.target_weight ?? 0, pos?.class_id || null);
    }
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

};

// ── API PROXY ──────────────────────────────────────────────────
// All market data calls go through Vercel serverless functions.
// API keys (AV_KEY, FH_KEY) live server-side only — never in the bundle.
async function proxyFetch(path, params = {}, method = 'GET', body = null) {
  const { data: { session } } = await S.db.auth.getSession();
  if (!session?.access_token) throw new Error('Not authenticated');

  const url = new URL(path, window.location.origin);
  if (method === 'GET') Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const fetchOpts = {
      method,
      headers: { Authorization: `Bearer ${session.access_token}` },
      signal: ctrl.signal,
    };
    if (method === 'POST' && body !== null) {
      fetchOpts.headers['Content-Type'] = 'application/json';
      fetchOpts.body = JSON.stringify(body);
    }
    const r = await fetch(url, fetchOpts);
    clearTimeout(timer);
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${r.status}`);
    }
    return r.json();
  } catch(e) {
    clearTimeout(timer);
    throw e.name === 'AbortError' ? new Error('Request timed out') : e;
  }
}

const API = {
  async _oneQuote(symbol) {
    const cached = Cache.get('q1_' + symbol);
    if (cached) return cached;

    // Check shared DB cache first (written by the server proxy with service role)
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

    const data = await proxyFetch('/api/quote', { symbol });
    if (data?.quote) {
      Cache.set('q1_' + symbol, data.quote, CACHE_Q);
      return data.quote;
    }
    return null;
  },

  async quotes(symbols) {
    const results = [];
    for (let i = 0; i < symbols.length; i += 5) {
      const batch = await Promise.all(
        symbols.slice(i, i + 5).map(sym =>
          this._oneQuote(sym).catch(e => { console.error(`[DIVIDND] Quote failed ${sym}:`, e.message); return null; })
        )
      );
      results.push(...batch.filter(Boolean));
      if (i + 5 < symbols.length) await sleep(12000);
    }
    return results;
  },

  async historical(symbol) {
    const cKey = `h_${symbol}`;
    const cached = Cache.get(cKey);
    if (cached) return cached;
    const data   = await proxyFetch('/api/historical', { symbol });
    const prices = data?.history || [];
    if (prices.length) Cache.set(cKey, prices, CACHE_H);
    return prices;
  },

  async dividends(symbol) {
    const cKey = `div_${symbol}`;
    const cached = Cache.get(cKey);
    if (cached) return cached;
    const data = await proxyFetch('/api/dividends', { symbol });
    const divs = data?.dividends || [];
    if (divs.length) Cache.set(cKey, divs, CACHE_H);
    return divs;
  },

  async overview(symbol) {
    const CACHE_OV = 7 * 24 * 60 * 60 * 1000; // 7 days
    const cKey = `ov_${symbol}`;
    const cached = Cache.get(cKey);
    if (cached) return cached;
    try {
      const data = await proxyFetch('/api/overview', { symbol });
      if (data?.overview) {
        Cache.set(cKey, data.overview, CACHE_OV);
        return data.overview;
      }
    } catch(e) {
      console.warn(`[API.overview] ${symbol}:`, e.message);
    }
    return null;
  },
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

// ── COMBINED VALUE ─────────────────────────────────────────────
async function loadAllPositions() {
  const ids = S.portfolios.map(p => p.id);
  if (!ids.length) { S.allPositions = []; return; }
  try {
    const { data: positions } = await S.db
      .from('positions').select('symbol,shares').in('folio_id', ids);
    S.allPositions = positions || [];

    // Fetch DB-cached quotes for any symbols not yet in memory
    const missing = [...new Set(S.allPositions.map(p => p.symbol))].filter(s => !S.quotes[s]);
    if (missing.length) {
      const { data: qrows } = await S.db.from('quotes').select('*').in('symbol', missing);
      if (qrows) qrows.forEach(r => {
        S.quotes[r.symbol] = {
          symbol: r.symbol, name: r.name || r.symbol,
          price: r.price ?? null, change: r.change ?? 0,
          changesPercentage: r.changes_percentage ?? 0,
          marketCap: r.market_cap || null, pe: r.pe || null,
          yearHigh: r.year_high ?? null, yearLow: r.year_low ?? null,
          dividendYield: r.dividend_yield ?? 0,
        };
      });
    }
  } catch(e) {
    console.warn('[DIVIDND] loadAllPositions failed:', e.message);
    S.allPositions = [];
  }
}

function combinedValue() {
  return S.allPositions.reduce((s, p) => s + (S.quotes[p.symbol]?.price ?? 0) * p.shares, 0);
}

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

// Reuse chart instance with .update('none') for data-only changes.
// Destroy + recreate when chart type changes (Chart.js requires this).
// portChartIsGain is module-level so the backgroundColor gradient closure
// always reflects the current gain state.
function buildPortChart(labels, vals) {
  const isGain = !vals.length || vals[vals.length - 1] >= vals[0];
  const col    = isGain ? '#14f0a8' : '#f0486e';
  portChartIsGain = isGain;

  const isBar = _portChartStyle === 'bar';

  // If same type and instance exists — update data in place
  if (S.charts.port && S.charts.port.config.type === _portChartStyle) {
    S.charts.port.data.labels = labels;
    S.charts.port.data.datasets[0].data = vals;
    if (!isBar) {
      S.charts.port.data.datasets[0].borderColor = col;
    } else {
      S.charts.port.data.datasets[0].backgroundColor = vals.map((v, i) =>
        i === 0 || v >= vals[i - 1] ? 'rgba(20,240,168,0.75)' : 'rgba(240,72,110,0.75)'
      );
    }
    S.charts.port.update('none');
    return;
  }

  // Destroy existing instance before switching type
  if (S.charts.port) { S.charts.port.destroy(); S.charts.port = null; }

  const canvas = $('c-portfolio');
  if (!canvas) return;

  const sharedOpts = {
    responsive: true, maintainAspectRatio: false,
    interaction: { mode:'index', intersect:false },
    plugins: { legend:{ display:false }, tooltip:{ ...TT, callbacks:{ label: c => ` ${f.$(c.parsed.y)}` } } },
    scales: {
      x: { grid:{ display:false }, ticks:{ maxTicksLimit:6, font:{ size:10 } } },
      y: { position:'right', grid:{ color:'rgba(255,255,255,0.04)' }, ticks:{ font:{ size:10 }, callback: v => f.$(v,0) } },
    },
  };

  if (isBar) {
    const barColors = vals.map((v, i) =>
      i === 0 || v >= vals[i - 1] ? 'rgba(20,240,168,0.75)' : 'rgba(240,72,110,0.75)'
    );
    S.charts.port = new Chart(canvas, {
      type: 'bar',
      data: { labels, datasets: [{ data: vals, backgroundColor: barColors, borderRadius: 2, borderSkipped: false }] },
      options: sharedOpts,
    });
  } else {
    S.charts.port = new Chart(canvas, {
      type: 'line',
      data: { labels, datasets: [{ data: vals, borderColor: col, borderWidth: 1.5, pointRadius: 0, fill: true, backgroundColor: ctx => lineGrad(ctx, portChartIsGain), tension: .35 }] },
      options: sharedOpts,
    });
  }
}

function togglePortChartStyle() {
  _portChartStyle = _portChartStyle === 'line' ? 'bar' : 'line';
  const btn = $('btn-chart-style');
  if (btn) btn.textContent = _portChartStyle === 'bar' ? '∿' : '▊';
  // Destroy so buildPortChart recreates with the new type
  if (S.charts.port) { S.charts.port.destroy(); S.charts.port = null; }
  loadPortChart(S.period).catch(e => console.warn('Port chart toggle:', e.message));
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
  const isCad = S.currency === 'CAD';
  const fxFmt = n => n == null ? '—' : new Intl.NumberFormat('en-US', {
    style: 'currency', currency: S.currency, minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(n * (isCad ? S.fxRate : 1));

  const displayVal = S.showCombined ? combinedValue() : val;
  const lblEl = $('sc-lbl-total');
  if (lblEl) lblEl.textContent = S.showCombined ? 'Combined Value' : 'Portfolio Value';
  $('btn-combined')?.classList.toggle('active', S.showCombined);

  set('s-total',   fxFmt(displayVal),    S.showCombined ? 'var(--accent)' : gc(allG));
  set('s-allgain',
    S.showCombined
      ? `${S.portfolios.length} portfolio${S.portfolios.length !== 1 ? 's' : ''}`
      : `${f.$(allG)} (${f.pct(allPct)})`,
    S.showCombined ? 'var(--muted)' : gc(allG));
  set('s-daygain',    f.$(dayG),                       gc(dayG));
  set('s-daypct',     f.pct(dayPct) + ' vs. yesterday', gc(dayG));
  set('s-allgain-abs', f.$(dayG),                      gc(dayG));
  set('s-allpct',  f.pct(allPct),        gc(allG));
  set('s-cost',    fxFmt(cost));
  set('s-count',   `${S.positions.length} position${S.positions.length !== 1 ? 's' : ''}`);

  const lu = $('upd-time');
  if (lu) lu.textContent = `Updated ${new Date().toLocaleTimeString()}`;

  buildAllocChart(Port.rows());
  updateLimitsDisplay();
  checkPriceAlerts();
}

function checkPriceAlerts() {
  const fire = (key, symbol, tp, dir) => {
    if (_alertedSyms.has(key)) return;
    _alertedSyms.add(key);
    toast(`${symbol} hit your target of ${f.$(tp)} ${dir}`);
  };
  S.positions.forEach(pos => {
    const tp = pos.target_price; if (!tp) return;
    const price = S.quotes[pos.symbol]?.price; if (!price) return;
    if (price >= tp) fire(`pos_${pos.symbol}`, pos.symbol, tp, '↑');
  });
  _watchlist.forEach(w => {
    const tp = w.target_price; if (!tp) return;
    const price = S.quotes[w.symbol]?.price; if (!price) return;
    if (price >= tp) fire(`wl_${w.symbol}`, w.symbol, tp, '↑');
  });
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
      <td style="text-align:right;padding-right:4px">
        ${h.target_price ? (() => {
          const tp = h.target_price, px = h.px;
          const hit  = px != null && px >= tp;
          const near = px != null && !hit && px >= tp * 0.97;
          const col  = hit ? 'var(--gain)' : near ? '#f0c05b' : 'var(--muted)';
          return `<div style="font-size:10px;color:${col};margin-bottom:3px" title="Price target">⊙ ${f.$(tp)}</div>`;
        })() : ''}
        <button class="btn btn-ghost"
          style="font-size:11px;padding:4px 8px;white-space:nowrap"
          onclick="event.stopPropagation();showTradeModal('${h.symbol}')"
          title="Log a buy or sell">+ Trade</button>
      </td>
    </tr>`;
}

function renderHoldings() {
  const tbody = $('holdings-body');
  if (!tbody) return;
  const rows = Port.rows();
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:40px;color:var(--muted)">No positions yet. Add them in Settings (⚙).</td></tr>`;
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
      html.push(`<tr class="class-header-row"><td colspan="9"><span class="class-name" style="color:var(--muted)">Ungrouped</span></td></tr>`);
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
          <td colspan="9">
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
  updateLimitsDisplay();
}

async function loadPortChart(period) {
  if (!S.positions.length) return;
  const days = { '1M':30, '3M':90, '6M':182, '1Y':365 }[period] || 30;
  const from = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];

  const syms = S.positions.map(h => h.symbol);
  const allHist = {};
  // Fetch all symbols in parallel — API.historical caches by symbol so period
  // switches reuse cached data; sorted ascending so chart renders oldest→newest
  await Promise.all(syms.map(async sym => {
    try {
      const full = await API.historical(sym);
      allHist[sym] = full
        .filter(d => d.date >= from)
        .sort((a, b) => a.date.localeCompare(b.date));
    } catch(e) {
      allHist[sym] = [];
    }
  }));

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
    <div id="stk-divs"><div class="spinner-wrap" style="padding:20px"><div class="spinner"></div></div></div>
    <div class="sec-title" style="margin-top:20px">Trade History</div>
    <div id="stk-trades"><div class="spinner-wrap" style="padding:20px"><div class="spinner"></div></div></div>`;

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
    if (el) el.innerHTML = `<span style="color:var(--muted);font-size:12px">Chart unavailable</span>`;
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
    if (el) el.innerHTML = `<p style="color:var(--muted);font-size:12px;text-align:center;padding:14px">Could not load dividend history</p>`;
  }

  // Load trade history
  try {
    const trades = await DB.listTrades(S.currentFolioId, symbol);
    const el = $('stk-trades');
    if (!el) return;
    renderTradeHistory(el, trades, symbol);
  } catch(e) {
    const el = $('stk-trades');
    if (el) el.innerHTML = `<p style="color:var(--muted);font-size:12px">Could not load trade history.</p>`;
  }
}

function renderTradeHistory(el, trades, symbol) {
  if (!trades.length) {
    el.innerHTML = `<p style="color:var(--muted);font-size:12px;text-align:center;padding:14px">No trades logged yet.</p>`;
    return;
  }
  el.innerHTML = `<div class="div-list">${trades.map(t => {
    const total = Number(t.shares) * Number(t.price);
    return `<div class="div-row" style="gap:8px">
      <span class="dr">${f.date(t.traded_at)}</span>
      <span style="display:flex;align-items:center;gap:6px">
        <span class="badge ${t.type === 'buy' ? 'gain' : 'loss'}" style="font-size:10px">${t.type.toUpperCase()}</span>
        <span>${f.num(Number(t.shares), Number(t.shares) % 1 === 0 ? 0 : 4)} sh @ ${f.$(Number(t.price))}</span>
      </span>
      <span style="display:flex;align-items:center;gap:6px;margin-left:auto">
        <span class="da">${f.$(total)}</span>
        <button class="btn btn-ghost trade-edit-btn" style="font-size:10px;padding:3px 7px" data-id="${t.id}">Edit</button>
        <button class="btn btn-ghost trade-del-btn" style="font-size:10px;padding:3px 7px;color:var(--loss);border-color:rgba(240,72,110,.3)" data-id="${t.id}">✕</button>
      </span>
    </div>`;
  }).join('')}</div>`;

  // Store trade data on the element for event handlers
  el._tradeData = Object.fromEntries(trades.map(t => [t.id, t]));
  el._symbol    = symbol;

  el.querySelectorAll('.trade-edit-btn').forEach(btn =>
    btn.addEventListener('click', () => showTradeModal(el._symbol, el._tradeData[btn.dataset.id]))
  );
  el.querySelectorAll('.trade-del-btn').forEach(btn =>
    btn.addEventListener('click', () => deleteTradeAndRecalc(btn.dataset.id, el._symbol))
  );
}

// ── TRADE MODAL ────────────────────────────────────────────────
function showTradeModal(symbol, trade = null) {
  _tradeModalSymbol = symbol;
  _editingTradeId   = trade ? trade.id : null;

  $('trade-modal-sym').textContent = symbol;

  const submitBtn = $('btn-submit-trade');
  submitBtn.textContent = trade ? 'Update Trade' : 'Log Trade';

  if (trade) {
    _setTradeType(trade.type);
    $('trade-shares').value = trade.shares;
    $('trade-price').value  = trade.price;
    $('trade-date').value   = trade.traded_at;
    $('trade-preview').innerHTML = '<span style="color:var(--muted)">Position will be fully recalculated from all trades after saving.</span>';
  } else {
    _setTradeType('buy');

    const today = new Date();
    const yyyy  = today.getFullYear();
    const mm    = String(today.getMonth() + 1).padStart(2, '0');
    const dd    = String(today.getDate()).padStart(2, '0');
    $('trade-date').value = `${yyyy}-${mm}-${dd}`;

    const px = S.quotes[symbol]?.price;
    $('trade-price').value  = px != null ? px : '';
    $('trade-shares').value = '';
    $('trade-preview').innerHTML = '<span style="color:var(--muted)">Enter shares and price to see preview.</span>';
  }

  $('ov-trade').classList.add('open');
  setTimeout(() => $('trade-shares').focus(), 50);
}

function _setTradeType(type) {
  const buyBtn  = $('trade-type-buy');
  const sellBtn = $('trade-type-sell');
  buyBtn.dataset.active  = type === 'buy'  ? '1' : '';
  sellBtn.dataset.active = type === 'sell' ? '1' : '';
  buyBtn.className  = `btn ${type === 'buy'  ? 'btn-accent' : 'btn-ghost'}`;
  sellBtn.className = `btn ${type === 'sell' ? 'btn-accent' : 'btn-ghost'}`;
  buyBtn.style.flex  = '1';
  buyBtn.style.justifyContent  = 'center';
  sellBtn.style.flex = '1';
  sellBtn.style.justifyContent = 'center';
  _updateTradePreview();
}

function _getTradeType() {
  return $('trade-type-buy').dataset.active === '1' ? 'buy' : 'sell';
}

function _updateTradePreview() {
  const el          = $('trade-preview');
  if (!el) return;
  if (_editingTradeId) {
    el.innerHTML = '<span style="color:var(--muted)">Position will be fully recalculated from all trades after saving.</span>';
    return;
  }
  const type        = _getTradeType();
  const tradeShares = parseFloat($('trade-shares').value);
  const tradePrice  = parseFloat($('trade-price').value);

  if (!tradeShares || tradeShares <= 0 || isNaN(tradePrice) || tradePrice < 0 || !$('trade-date').value) {
    el.innerHTML = '<span style="color:var(--muted)">Enter shares and price to see preview.</span>';
    return;
  }

  const pos = S.positions.find(p => p.symbol === _tradeModalSymbol);

  if (type === 'buy') {
    const oldShares  = pos?.shares ?? 0;
    const newShares  = oldShares + tradeShares;
    const newAvgCost = oldShares > 0
      ? ((oldShares * pos.avg_cost) + (tradeShares * tradePrice)) / newShares
      : tradePrice;
    const total = tradeShares * tradePrice;
    el.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:6px">
        <div style="display:flex;justify-content:space-between"><span>Trade Total</span><span class="mono">${f.$(total)}</span></div>
        <div style="display:flex;justify-content:space-between"><span>New Shares</span><span class="mono">${f.num(newShares, newShares % 1 === 0 ? 0 : 4)}</span></div>
        <div style="display:flex;justify-content:space-between"><span>New Avg Cost</span><span class="mono" style="color:var(--accent)">${f.$(newAvgCost)}</span></div>
      </div>`;
  } else {
    const oldShares = pos?.shares ?? 0;
    if (tradeShares > oldShares + 0.0001) {
      el.innerHTML = `<span style="color:var(--loss)">Cannot sell more shares than held (${f.num(oldShares, oldShares % 1 === 0 ? 0 : 4)} sh).</span>`;
      return;
    }
    const proceeds  = tradeShares * tradePrice;
    const costBasis = tradeShares * (pos?.avg_cost ?? 0);
    const realizedGL = proceeds - costBasis;
    const newShares  = oldShares - tradeShares;
    el.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:6px">
        <div style="display:flex;justify-content:space-between"><span>Proceeds</span><span class="mono">${f.$(proceeds)}</span></div>
        <div style="display:flex;justify-content:space-between"><span>Realized G/L</span><span class="mono ${sign(realizedGL)}">${f.$(realizedGL)}</span></div>
        <div style="display:flex;justify-content:space-between"><span>Remaining Shares</span><span class="mono" style="color:${newShares <= 0.0001 ? 'var(--loss)' : 'var(--text)'}">${newShares <= 0.0001 ? 'Closes position' : f.num(newShares, newShares % 1 === 0 ? 0 : 4)}</span></div>
      </div>`;
  }
}

async function submitTrade() {
  const type        = _getTradeType();
  const tradeShares = parseFloat($('trade-shares').value);
  const tradePrice  = parseFloat($('trade-price').value);
  const tradedAt    = $('trade-date').value;
  const symbol      = _tradeModalSymbol;
  const isEdit      = !!_editingTradeId;

  if (!tradeShares || tradeShares <= 0) { toast('Enter a valid number of shares.', 'error'); return; }
  if (isNaN(tradePrice) || tradePrice < 0) { toast('Enter a valid price.', 'error'); return; }
  if (!tradedAt) { toast('Select a trade date.', 'error'); return; }

  const pos = S.positions.find(p => p.symbol === symbol);

  // Sell validation only for new trades (edit recalcs from scratch)
  if (!isEdit && type === 'sell') {
    const oldShares = pos?.shares ?? 0;
    if (tradeShares > oldShares + 0.0001) {
      toast(`Cannot sell more shares than held (${f.num(oldShares, oldShares % 1 === 0 ? 0 : 4)} sh).`, 'error');
      return;
    }
  }

  if (!isEdit && type === 'buy' && !pos) {
    if (!isPremium() && S.positions.length >= FREE_LIMITS.positions) {
      showUpgradeModal('position');
      return;
    }
  }

  const btn = $('btn-submit-trade');
  btn.disabled = true;
  btn.textContent = isEdit ? 'Saving…' : 'Logging…';

  try {
    if (isEdit) {
      await DB.updateTrade(_editingTradeId, type, tradeShares, tradePrice, tradedAt);
      await DB.recalcPositionFromTrades(S.currentFolioId, symbol);
      toast(`Trade updated for ${symbol}`);
    } else {
      await DB.insertTrade(S.currentFolioId, symbol, type, tradeShares, tradePrice, tradedAt);

      if (type === 'buy') {
        const oldShares  = pos?.shares ?? 0;
        const newShares  = oldShares + tradeShares;
        const newAvgCost = oldShares > 0
          ? ((oldShares * pos.avg_cost) + (tradeShares * tradePrice)) / newShares
          : tradePrice;
        await DB.upsertPosition(
          S.currentFolioId, symbol, newShares, newAvgCost,
          pos?.color || null, pos?.target_weight ?? 0, pos?.class_id || null
        );
        toast(`Bought ${f.num(tradeShares, tradeShares % 1 === 0 ? 0 : 4)} sh of ${symbol}`);
      } else {
        const oldShares = pos?.shares ?? 0;
        const newShares = oldShares - tradeShares;
        if (newShares <= 0.0001) {
          await DB.deletePosition(S.currentFolioId, symbol);
          toast(`Closed position: ${symbol}`);
        } else {
          await DB.upsertPosition(
            S.currentFolioId, symbol, newShares, pos.avg_cost,
            pos?.color || null, pos?.target_weight ?? 0, pos?.class_id || null
          );
          toast(`Sold ${f.num(tradeShares, tradeShares % 1 === 0 ? 0 : 4)} sh of ${symbol}`);
        }
      }
    }

    S.positions = await DB.listPositions(S.currentFolioId);
    closeOverlay('ov-trade');
    renderDash();
    renderHoldings();
  } catch(e) {
    // Error already surfaced by DB layer
  } finally {
    btn.disabled = false;
    btn.textContent = isEdit ? 'Update Trade' : 'Log Trade';
  }
}

async function deleteTradeAndRecalc(tradeId, symbol) {
  if (!confirm(`Delete this trade? Your position will be recalculated from remaining trades.`)) return;
  try {
    await DB.deleteTrade(tradeId);
    await DB.recalcPositionFromTrades(S.currentFolioId, symbol);
    S.positions = await DB.listPositions(S.currentFolioId);
    renderDash();
    renderHoldings();
    toast(`Trade deleted — ${symbol} position recalculated`);
    // Refresh the trade history section if stock modal is still open
    const tradesEl = $('stk-trades');
    if (tradesEl) {
      const trades = await DB.listTrades(S.currentFolioId, symbol);
      renderTradeHistory(tradesEl, trades, symbol);
    }
  } catch(e) {
    // Error already surfaced by DB layer
  }
}

// ── STATS TAB ──────────────────────────────────────────────────
// ── DIVIDENDS TAB ──────────────────────────────────────────────

async function _loadDividendYields(positions) {
  // Fetch OVERVIEW for any position where dividend yield is unknown and not yet tried
  // Sequential to respect AV rate limits (25 req/min free tier)
  const missing = positions.filter(p =>
    !(S.quotes[p.symbol]?.dividendYield > 0) && !_overviewFetched.has(p.symbol)
  );
  if (!missing.length) return false; // nothing new to fetch
  for (const p of missing) {
    _overviewFetched.add(p.symbol); // mark before fetch to prevent parallel re-entry
    try {
      const ov = await API.overview(p.symbol);
      if (ov) {
        if (!S.quotes[p.symbol]) S.quotes[p.symbol] = { symbol: p.symbol };
        S.quotes[p.symbol].dividendYield = ov.dividendYield ?? 0;
      }
    } catch(e) { /* skip */ }
  }
  return true; // fetched at least one
}

function _getDivPositions() {
  return S.positions.map(p => {
    const q              = S.quotes[p.symbol];
    const price          = q?.price || 0;
    const yieldDecimal   = q?.dividendYield || 0;          // e.g. 0.0157
    const annualDivPerSh = price * yieldDecimal;            // $ per share per year
    const annualIncome   = p.shares * annualDivPerSh;
    const yoc            = p.avg_cost > 0 ? (annualDivPerSh / p.avg_cost) * 100 : 0;
    return { ...p, price, yieldPct: yieldDecimal * 100, annualDivPerSh, annualIncome, yoc };
  }).filter(p => (S.quotes[p.symbol]?.dividendYield || 0) > 0)
    .sort((a, b) => b.annualIncome - a.annualIncome);
}

function _renderDivHoldings(divPos) {
  const tbody = $('div-holdings-body');
  if (!tbody) return;
  if (!divPos.length) {
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:24px;font-size:13px">No dividend-paying positions found.</td></tr>`;
    return;
  }
  tbody.innerHTML = divPos.map(p => {
    const color    = p.color || '#14f0a8';
    const yocStyle = p.yoc > p.yieldPct && p.yoc > 0 ? 'color:var(--gain)' : 'color:var(--muted)';
    return `<tr>
      <td><span style="display:inline-flex;align-items:center;gap:6px">
        <span style="width:8px;height:8px;border-radius:50%;background:${color};flex-shrink:0"></span>${p.symbol}
      </span></td>
      <td>${p.yieldPct > 0 ? f.num(p.yieldPct, 2) + '%' : '—'}</td>
      <td style="${yocStyle}">${p.yoc > 0 ? f.num(p.yoc, 2) + '%' : '—'}</td>
      <td style="color:var(--gain)">${p.annualIncome > 0.01 ? f.$(p.annualIncome) : '—'}</td>
    </tr>`;
  }).join('');
}

function _divProjectDates(symbol, yr, mo) {
  const hist = (_divHistCache?.[symbol] || [])
    .filter(d => d.date && d.dividend > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (hist.length < 2) return [];

  const intervals = [];
  for (let i = 1; i < Math.min(hist.length, 8); i++) {
    const ms = new Date(hist[i].date + 'T00:00:00') - new Date(hist[i-1].date + 'T00:00:00');
    intervals.push(ms / 86400000);
  }
  const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
  const lastAmt  = hist[hist.length - 1].dividend;
  const lastDate = new Date(hist[hist.length - 1].date + 'T00:00:00');
  const tStart   = new Date(yr, mo, 1);
  const tEnd     = new Date(yr, mo + 1, 0);

  const results = [];
  const seen    = new Set();
  const check   = d => {
    if (d >= tStart && d <= tEnd) {
      const day = d.getDate();
      if (!seen.has(day)) { seen.add(day); results.push({ day, amount: lastAmt }); }
    }
  };
  let d = new Date(lastDate);
  while (d <= tEnd) { d = new Date(d.getTime() + avgInterval * 86400000); check(d); }
  d = new Date(lastDate);
  while (d >= tStart) { d = new Date(d.getTime() - avgInterval * 86400000); check(d); }
  return results;
}

function _renderDivCalendar() {
  const calEl = $('div-cal');
  if (!calEl) return;
  const yr = _divCalYear, mo = _divCalMonth;
  const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const lbl = $('div-cal-label');
  if (lbl) lbl.textContent = `${MONTHS[mo]} ${yr}`;

  const today    = new Date();
  const firstDay = new Date(yr, mo, 1).getDay();
  const daysInMo = new Date(yr, mo + 1, 0).getDate();
  const divPos   = _getDivPositions();

  // Build events map: day → [{symbol,color,amount,shares,projected}]
  const events = {};
  const add = (day, ev) => { (events[day] = events[day] || []).push(ev); };

  divPos.forEach(p => {
    const hist   = _divHistCache?.[p.symbol] || [];
    let hasActual = false;
    hist.forEach(d => {
      if (!d.date) return;
      const dt = new Date(d.date + 'T00:00:00');
      if (dt.getFullYear() === yr && dt.getMonth() === mo) {
        hasActual = true;
        add(dt.getDate(), { symbol: p.symbol, color: p.color || '#14f0a8', amount: d.dividend, shares: p.shares });
      }
    });
    if (!hasActual && _divHistCache) {
      _divProjectDates(p.symbol, yr, mo).forEach(proj =>
        add(proj.day, { symbol: p.symbol, color: p.color || '#14f0a8', amount: proj.amount, shares: p.shares, projected: true })
      );
    }
  });

  let html = '';
  for (let i = 0; i < firstDay; i++) html += '<div></div>';
  for (let day = 1; day <= daysInMo; day++) {
    const isToday = today.getFullYear() === yr && today.getMonth() === mo && today.getDate() === day;
    const evs     = events[day] || [];
    html += `<div class="div-cal-day${evs.length ? ' has-ev' : ''}${isToday ? ' today' : ''}">`;
    html += `<div class="div-cal-dn">${day}</div>`;
    evs.slice(0, 3).forEach(ev => {
      const tip = `${ev.symbol} · $${ev.amount?.toFixed(4) ?? '?'}/sh · Est. ${f.$(ev.amount * ev.shares)}${ev.projected ? ' (projected)' : ''}`;
      html += `<div class="div-chip" style="background:${ev.color}22;color:${ev.color}" title="${tip}">${ev.symbol}</div>`;
    });
    if (evs.length > 3) html += `<div class="div-chip" style="background:var(--card);color:var(--muted)">+${evs.length - 3}</div>`;
    html += '</div>';
  }
  calEl.innerHTML = html;

  // Show a note if history has loaded but all results are empty (premium AV key required)
  const noteEl = $('div-cal-note');
  if (noteEl) {
    const hasHistory = divPos.some(p => (_divHistCache?.[p.symbol] || []).length > 0);
    const histLoaded = _divHistCache !== null;
    if (histLoaded && !hasHistory && divPos.length > 0) {
      noteEl.textContent = 'Dividend dates require an Alpha Vantage premium key. Calendar shows projected dates only when history is available.';
      noteEl.style.display = '';
    } else {
      noteEl.style.display = 'none';
    }
  }
}

function _renderDivHistory(divPos) {
  const wrap = $('div-history-wrap');
  if (!wrap || !_divHistCache) return;

  const all = [];
  divPos.forEach(p => {
    (_divHistCache[p.symbol] || []).forEach(d => {
      if (d.date && d.dividend > 0)
        all.push({ date: d.date, symbol: p.symbol, color: p.color || '#14f0a8', amtPerSh: d.dividend, shares: p.shares });
    });
  });
  all.sort((a, b) => b.date.localeCompare(a.date));

  if (!all.length) {
    wrap.innerHTML = `<p style="color:var(--muted);font-size:13px;text-align:center;padding:24px">No dividend history available. Requires an Alpha Vantage premium API key.</p>`;
    return;
  }
  wrap.innerHTML = `<div class="div-list">${all.slice(0, 50).map(d => `
    <div class="div-row">
      <span class="dr">${f.date(d.date)}</span>
      <span style="display:flex;align-items:center;gap:6px">
        <span style="background:${d.color}22;color:${d.color};font-size:10px;padding:2px 7px;border-radius:5px;font-weight:700">${d.symbol}</span>
        <span style="font-size:12px;color:var(--muted)">${f.num(d.amtPerSh, 4)}/sh × ${f.num(d.shares, d.shares % 1 === 0 ? 0 : 4)} sh</span>
      </span>
      <span class="da" style="color:var(--gain)">${f.$(d.amtPerSh * d.shares)}</span>
    </div>`).join('')}</div>`;
}

async function renderDividends() {
  const empty   = $('div-empty');
  const content = $('div-content');
  if (!S.positions.length) {
    if (empty)   empty.style.display   = '';
    if (content) content.style.display = 'none';
    return;
  }
  if (empty)   empty.style.display   = 'none';
  if (content) content.style.display = '';

  // Fetch OVERVIEW for positions missing dividend yield — re-render only if we got new data
  _loadDividendYields(S.positions).then(fetched => { if (fetched) renderDividends(); });

  const divPos = _getDivPositions();

  // Stat cards — immediate from quotes
  const annualIncome = divPos.reduce((s, p) => s + p.annualIncome, 0);
  const portValue    = Port.value();
  const portCost     = Port.cost();
  const portYield    = portValue > 0 ? (annualIncome / portValue) * 100 : 0;
  const avgYoc       = portCost  > 0 ? (annualIncome / portCost)  * 100 : 0;

  const upd = (id, text, cls) => {
    const el = $(id); if (!el) return;
    el.textContent = text;
    if (cls) { el.className = el.className.replace(/\bc-(gain|loss|muted)\b/, ''); el.classList.add('c-' + cls); }
  };
  upd('div-stat-annual',  annualIncome > 0 ? f.$(annualIncome)          : '—', annualIncome > 0 ? 'gain' : 'muted');
  upd('div-stat-monthly', annualIncome > 0 ? f.$(annualIncome / 12)     : '—', annualIncome > 0 ? 'gain' : 'muted');
  upd('div-stat-yield',   portYield    > 0 ? f.num(portYield, 2) + '%'  : '—', portYield    > 0 ? 'gain' : 'muted');
  upd('div-stat-yoc',     avgYoc       > 0 ? f.num(avgYoc, 2) + '%'     : '—', avgYoc >= portYield && avgYoc > 0 ? 'gain' : 'muted');
  const posEl = $('div-stat-positions');
  if (posEl) posEl.textContent = divPos.length ? `${divPos.length} paying position${divPos.length !== 1 ? 's' : ''}` : 'no dividend payers';

  // Render holdings table immediately
  _renderDivHoldings(divPos);

  // Render calendar with what we have so far (no history yet)
  _renderDivCalendar();

  // Fetch dividend history for all paying positions
  if (!_divHistCache) {
    _divHistCache = {};
    await Promise.all(divPos.map(async p => {
      try {
        const data = await proxyFetch('/api/dividends', { symbol: p.symbol });
        _divHistCache[p.symbol] = (data?.dividends || []).map(d => ({ date: d.date, dividend: d.dividend ?? d.amount }));
      } catch(e) { _divHistCache[p.symbol] = []; }
    }));
  }

  // Re-render calendar with actual history data
  _renderDivCalendar();
  // Render history table
  _renderDivHistory(divPos);

  // Pre-fill DRIP start with current portfolio value, then render
  const dripStart = $('drip-start');
  if (dripStart && (!dripStart.value || parseFloat(dripStart.value) === 0)) {
    dripStart.value = Math.round(portValue);
  }
  _renderDripProjection(portYield, annualIncome);
}

function _renderDripProjection(portYield, annualIncome) {
  const canvas = $('c-drip');
  if (!canvas) return;

  const annRet    = parseFloat($('drip-return')?.value) || 7;
  const years     = parseInt($('drip-years')?.value) || 20;
  const startVal  = parseFloat($('drip-start')?.value) || Port.value();
  if (startVal <= 0) return;

  const monthlyRet = annRet / 100 / 12;
  const monthlyDiv = (portYield / 100) / 12;
  const months     = years * 12;

  let dripVal = startVal, cashPortVal = startVal, cashAccum = 0;
  const dripSeries = [startVal], cashSeries = [startVal];
  const labels = ['Now'];

  for (let m = 1; m <= months; m++) {
    dripVal    *= (1 + monthlyRet + monthlyDiv);
    cashPortVal *= (1 + monthlyRet);
    cashAccum  += cashPortVal * monthlyDiv;
    if (m % 12 === 0) {
      dripSeries.push(dripVal);
      cashSeries.push(cashPortVal + cashAccum);
      labels.push(`Yr ${m / 12}`);
    }
  }

  const dripFinal = dripSeries[dripSeries.length - 1];
  const cashFinal = cashSeries[cashSeries.length - 1];
  const advantage = dripFinal - cashFinal;

  // Stat cards
  const statRow = $('drip-stat-row');
  if (statRow) {
    statRow.innerHTML = [
      ['DRIP Final Value', f.$(dripFinal), 'gain'],
      ['Cash Final Value', f.$(cashFinal), 'muted'],
      ['DRIP Advantage', f.$(advantage) + ` (+${f.pct(advantage/cashFinal*100)})`, 'gain'],
    ].map(([lbl, val, cls]) => `
      <div class="sc" style="padding:12px 14px">
        <div class="sc-lbl">${lbl}</div>
        <div class="sc-val c-${cls}">${val}</div>
        <div class="sc-sub" style="font-size:10px">${years}y projection · ${f.num(portYield, 2)}% yield</div>
      </div>`).join('');
  }

  if (S.charts.drip) { S.charts.drip.destroy(); S.charts.drip = null; }
  S.charts.drip = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label:'With DRIP',         data:dripSeries, borderColor:'#14f0a8', borderWidth:2,   pointRadius:0, fill:false, tension:.35 },
        { label:'Cash (no reinvest)', data:cashSeries, borderColor:'rgba(90,102,128,.8)', borderWidth:1.5, pointRadius:0, fill:false, tension:.35, borderDash:[4,3] },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display:true, labels:{ boxWidth:12, font:{size:11}, color:'#5a6680', usePointStyle:true, pointStyleWidth:16 } },
        tooltip: { ...TT, callbacks: { label: c => ` ${c.dataset.label}: ${f.$(c.parsed.y)}` } },
      },
      scales: {
        x: { grid:{display:false}, ticks:{maxTicksLimit:10, font:{size:9}} },
        y: { position:'right', grid:{color:'rgba(255,255,255,0.04)'}, ticks:{font:{size:9}, callback:v => f.compact(v)} },
      },
    },
  });
}

// ── WATCHLIST TAB ──────────────────────────────────────────────

async function renderWatchlist() {
  const wrap = $('wl-table-wrap');
  if (!wrap) return;
  wrap.innerHTML = '<div class="spinner-wrap"><div class="spinner"></div></div>';

  _watchlist = await DB.listWatchlist();

  if (!_watchlist.length) {
    wrap.innerHTML = `<div style="text-align:center;padding:60px 0;color:var(--muted)">
      <div style="font-size:15px;font-weight:600;margin-bottom:8px">Your watchlist is empty</div>
      <div style="font-size:13px">Add ticker symbols above to start tracking.</div>
    </div>`;
    return;
  }

  _renderWatchlistTable(); // skeleton with cached data

  // Fetch any missing quotes
  await Promise.all(_watchlist.map(async w => {
    if (S.quotes[w.symbol]?.price) return;
    try {
      const q = await API._oneQuote(w.symbol);
      if (q) S.quotes[w.symbol] = q;
    } catch(e) {}
  }));

  _renderWatchlistTable();
}

function _renderWatchlistTable() {
  const wrap = $('wl-table-wrap');
  if (!wrap || !_watchlist.length) return;

  const rows = _watchlist.map(w => {
    const q      = S.quotes[w.symbol];
    const price  = q?.price               ?? null;
    const chg    = q?.change              ?? null;
    const chgPct = q?.changesPercentage   ?? null;
    const hi52   = q?.yearHigh            ?? null;
    const lo52   = q?.yearLow             ?? null;
    const mktCap = q?.marketCap           ?? null;
    const name   = q?.name               || '';
    const gc     = n => n == null ? '' : n >= 0 ? 'var(--gain)' : 'var(--loss)';

    const tp     = w.target_price;
    const hit    = tp && price != null && price >= tp;
    const near   = tp && price != null && !hit && price >= tp * 0.97;
    const tpCol  = hit ? 'var(--gain)' : near ? '#f0c05b' : 'var(--muted)';
    const tpDisp = tp ? `<span style="color:${tpCol}">⊙ ${f.$(tp)}</span>` : '';

    return `<tr>
      <td>
        <div class="wl-sym">${esc(w.symbol)}</div>
        ${name ? `<div class="wl-name">${esc(name)}</div>` : ''}
        ${w.note ? `<div class="wl-note">"${esc(w.note)}"</div>` : ''}
      </td>
      <td style="color:var(--text);font-weight:600">${price != null ? f.$(price) : '—'}</td>
      <td style="color:${gc(chg)}">${chg != null ? (chg >= 0 ? '+' : '') + f.$(Math.abs(chg)) : '—'}</td>
      <td style="color:${gc(chgPct)}">${chgPct != null ? f.pct(chgPct) : '—'}</td>
      <td>${hi52 != null ? f.$(hi52) : '—'}</td>
      <td>${lo52 != null ? f.$(lo52) : '—'}</td>
      <td>${mktCap != null ? f.compact(mktCap) : '—'}</td>
      <td>
        <div style="display:flex;align-items:center;gap:6px">
          <div>
            ${tpDisp}
            <input class="wl-target-input" type="number" placeholder="Target $" value="${tp ?? ''}"
              min="0" step="any" data-id="${w.id}"
              style="width:80px;padding:4px 6px;background:var(--card);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:11px;font-family:var(--mono);outline:none"
              title="Set a price target — toast fires when price hits it">
          </div>
          <button class="wl-remove" onclick="removeFromWatchlist('${w.id}')" title="Remove">✕</button>
        </div>
      </td>
    </tr>`;
  }).join('');

  wrap.innerHTML = `<table class="wl-tbl">
    <thead><tr>
      <th>Symbol</th><th>Price</th><th>Chg $</th><th>Chg %</th>
      <th>52W High</th><th>52W Low</th><th>Mkt Cap</th><th>Target / Action</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;

  // Wire target price inputs — save on blur or Enter
  wrap.querySelectorAll('.wl-target-input').forEach(input => {
    const save = async () => {
      const id  = input.dataset.id;
      const val = input.value !== '' ? parseFloat(input.value) : null;
      const item = _watchlist.find(w => w.id === id);
      if (!item || item.target_price === val) return;
      item.target_price = val;
      await DB.updateWatchlistTarget(id, val);
      _alertedSyms.delete(`wl_${item.symbol}`); // reset so alert can re-fire
      _renderWatchlistTable();
    };
    input.addEventListener('blur', save);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
  });
}

async function addToWatchlist() {
  const input = $('wl-input');
  if (!input) return;
  const sym = input.value.trim().toUpperCase().replace(/[^A-Z0-9.-]/g, '');
  if (!sym) return;
  if (_watchlist.some(w => w.symbol === sym)) {
    toast(`${sym} is already in your watchlist`, 'error'); return;
  }
  try {
    const item = await DB.addWatchlist(sym);
    _watchlist.unshift(item);
    input.value = '';
    _renderWatchlistTable();
    toast(`${sym} added to watchlist`);
    // Fetch quote in background then re-render
    try {
      const q = await API._oneQuote(sym);
      if (q) { S.quotes[sym] = q; _renderWatchlistTable(); }
    } catch(e) {}
  } catch(e) {
    if (e?.code === '23505') toast(`${sym} is already in your watchlist`, 'error');
    else toast('Could not add — check the ticker and try again', 'error');
  }
}

async function removeFromWatchlist(id) {
  await DB.removeWatchlist(id);
  _watchlist = _watchlist.filter(w => w.id !== id);
  if (_watchlist.length) _renderWatchlistTable();
  else renderWatchlist();
}

function _statsPeriodFrom(period) {
  if (period === 'YTD') return `${new Date().getFullYear()}-01-01`;
  const days = { '1M':30, '3M':90, '6M':182, '1Y':365 }[period] || 30;
  return new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
}

async function renderStats() {
  const empty   = $('stats-empty');
  const content = $('stats-content');

  if (!S.positions.length) {
    if (empty)   empty.style.display   = '';
    if (content) content.style.display = 'none';
    return;
  }
  if (empty)   empty.style.display   = 'none';
  if (content) content.style.display = '';

  const gc  = n => n >= 0 ? 'gain' : 'loss';
  const upd = (id, text, cls) => {
    const el = $(id);
    if (!el) return;
    el.textContent = text;
    if (cls) { el.className = el.className.replace(/\bc-(gain|loss|muted)\b/, ''); el.classList.add('c-' + cls); }
  };

  // ── Stat cards — immediate (no API needed) ─────────────────
  const value       = Port.value();
  const cost        = Port.cost();
  const totalRetPct = cost > 0 ? (value - cost) / cost * 100 : null;
  const totalRetDol = value - cost;

  upd('stat-total-pct', totalRetPct != null ? f.pct(totalRetPct) : '—', totalRetPct != null ? gc(totalRetDol) : 'muted');
  upd('stat-total-dol', f.$(totalRetDol));

  const withRet = S.positions.map(h => {
    const px  = S.quotes[h.symbol]?.price ?? null;
    const ret = px != null && h.avg_cost > 0 ? (px - h.avg_cost) / h.avg_cost * 100 : null;
    return { ...h, px, ret };
  }).filter(h => h.ret != null).sort((a, b) => b.ret - a.ret);

  if (withRet.length) {
    const best = withRet[0], worst = withRet[withRet.length - 1];
    upd('stat-best-sym',  best.symbol,    gc(best.ret));
    upd('stat-best-ret',  f.pct(best.ret));
    upd('stat-worst-sym', worst.symbol,   gc(worst.ret));
    upd('stat-worst-ret', f.pct(worst.ret));
  }

  // ── Position returns chart — immediate ─────────────────────
  if (withRet.length) {
    const sorted = [...withRet].reverse(); // worst → best for bottom-up bar
    if (S.charts.posReturns) { S.charts.posReturns.destroy(); S.charts.posReturns = null; }
    const canvas = $('c-pos-returns');
    if (canvas) {
      canvas.parentElement.style.height = Math.max(160, sorted.length * 38) + 'px';
      S.charts.posReturns = new Chart(canvas, {
        type: 'bar',
        data: {
          labels: sorted.map(p => p.symbol),
          datasets: [{ data: sorted.map(p => p.ret), backgroundColor: sorted.map(p => p.ret >= 0 ? 'rgba(20,240,168,.7)' : 'rgba(240,72,110,.7)'), borderRadius: 4 }],
        },
        options: {
          indexAxis: 'y', responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false }, tooltip: { ...TT, callbacks: { label: c => ` ${f.pct(c.parsed.x)}` } } },
          scales: {
            x: { grid: { color:'rgba(255,255,255,0.04)' }, ticks: { font:{size:9}, callback: v => f.pct(v,1) } },
            y: { grid: { display:false }, ticks: { font:{size:11, weight:'600'} } },
          },
        },
      });
    }
  }

  // ── Historical data + benchmark chart — async ───────────────
  const loadingEl = $('bench-loading');
  if (loadingEl) loadingEl.style.display = '';

  try {
    if (!_statsHistCache) {
      const syms = S.positions.map(h => h.symbol);
      const hist = {};
      await Promise.all([...syms, _benchmarkSym].map(async sym => {
        try { hist[sym] = await API.historical(sym); } catch(e) { hist[sym] = []; }
      }));
      _statsHistCache = hist;
    }
    _renderBenchChart();
  } catch(e) {
    if (loadingEl) loadingEl.innerHTML = `<span style="color:var(--muted);font-size:12px">Chart unavailable</span>`;
  }
}

function _renderBenchChart() {
  const allHist   = _statsHistCache;
  const loadingEl = $('bench-loading');
  if (!allHist) return;

  const from = _statsPeriodFrom(_statsPeriod);

  // Filter benchmark to selected period; fall back to full history if not enough
  let benchSorted = (allHist[_benchmarkSym] || [])
    .filter(d => d.date >= from)
    .sort((a, b) => a.date.localeCompare(b.date));

  if (benchSorted.length < 2) {
    benchSorted = (allHist[_benchmarkSym] || [])
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  if (benchSorted.length < 2) {
    if (loadingEl) loadingEl.innerHTML = `<span style="color:var(--muted);font-size:12px">Historical data unavailable — check your API key in Settings.</span>`;
    return;
  }

  const allDates    = benchSorted.map(d => d.date);
  const allBenchVal = benchSorted.map(d => d.close);

  // Portfolio value per date — 0 for dates where a position has no data yet
  const allPortVal = allDates.map(date =>
    S.positions.reduce((sum, h) => {
      const entry = (allHist[h.symbol] || []).find(d => d.date === date);
      return sum + (entry ? entry.close * h.shares : 0);
    }, 0)
  );

  // Trim to the first date where we actually have portfolio price data
  const firstIdx = allPortVal.findIndex(v => v > 0);
  if (firstIdx < 0 || firstIdx >= allPortVal.length - 1) {
    if (loadingEl) loadingEl.innerHTML = `<span style="color:var(--muted);font-size:12px">No historical price data for your holdings yet.</span>`;
    return;
  }

  const dates      = allDates.slice(firstIdx);
  const portVals   = allPortVal.slice(firstIdx);
  const benchVals  = allBenchVal.slice(firstIdx);

  // Normalize: both series start at 0%
  const p0 = portVals[0], b0 = benchVals[0];
  const portNorm  = portVals.map(v  => (v / p0 - 1) * 100);
  const benchNorm = benchVals.map(v => (v / b0 - 1) * 100);

  // Period return stat cards
  const portPeriodPct  = portNorm[portNorm.length - 1];
  const benchPeriodPct = benchNorm[benchNorm.length - 1];
  const portPeriodDol  = portVals[portVals.length - 1] - portVals[0];
  const vsSpyDiff      = portPeriodPct - benchPeriodPct;

  const gc = n => n >= 0 ? 'gain' : 'loss';
  const upd = (id, text, cls) => {
    const el = $(id);
    if (!el) return;
    el.textContent = text;
    if (cls) { el.className = el.className.replace(/\bc-(gain|loss|muted)\b/, ''); el.classList.add('c-' + cls); }
  };

  // If we're showing less than the requested period, reflect that in the label
  const actualFrom  = dates[0];
  const periodLabel = actualFrom > from
    ? `Since ${new Date(actualFrom + 'T00:00:00').toLocaleDateString('en-US', { month:'short', day:'numeric' })}`
    : (_statsPeriod === 'YTD' ? 'YTD Return' : `${_statsPeriod} Return`);

  $('stat-period-label') && ($('stat-period-label').textContent = periodLabel);
  upd('stat-period-pct', f.pct(portPeriodPct), gc(portPeriodPct));
  upd('stat-period-dol', f.$(portPeriodDol));
  upd('stat-vs-spy',     (vsSpyDiff >= 0 ? '+' : '') + f.num(vsSpyDiff, 2) + 'pp', gc(vsSpyDiff));
  $('stat-vs-spy-sub')   && ($('stat-vs-spy-sub').textContent   = `You: ${f.pct(portPeriodPct)} · ${_benchmarkSym}: ${f.pct(benchPeriodPct)}`);
  $('stat-vs-bench-lbl') && ($('stat-vs-bench-lbl').textContent = `vs ${_benchmarkSym}`);

  // Update dynamic labels
  const benchLabel = BENCH_LABELS[_benchmarkSym] || _benchmarkSym;
  $('bench-chart-title') && ($('bench-chart-title').textContent = `Portfolio vs ${benchLabel}`);

  // Build chart
  const labels = dates.map(d =>
    new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month:'short', day:'numeric' })
  );
  if (S.charts.bench) { S.charts.bench.destroy(); S.charts.bench = null; }
  const canvas = $('c-bench');
  if (canvas) {
    S.charts.bench = new Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label:'Your Portfolio', data:portNorm,  borderColor:portPeriodPct>=0?'#14f0a8':'#f0486e', borderWidth:2,   pointRadius:0, fill:false, tension:.35 },
          { label: BENCH_LABELS[_benchmarkSym] || _benchmarkSym, data:benchNorm, borderColor:'rgba(90,102,128,.8)',     borderWidth:1.5, pointRadius:0, fill:false, tension:.35, borderDash:[4,3] },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display:true, labels:{ boxWidth:12, font:{size:11}, color:'#5a6680', usePointStyle:true, pointStyleWidth:16 } },
          tooltip: { ...TT, callbacks: { label: c => ` ${c.dataset.label}: ${f.pct(c.parsed.y)}` } },
        },
        scales: {
          x: { grid:{display:false}, ticks:{maxTicksLimit:6, font:{size:9}} },
          y: { position:'right', grid:{color:'rgba(255,255,255,0.04)'}, ticks:{font:{size:9}, callback:v => f.pct(v,1)} },
        },
      },
    });
  }

  if (loadingEl) loadingEl.style.display = 'none';
  _renderRollingReturns();
  _renderCorrelation();
}

function _renderRollingReturns() {
  const allHist = _statsHistCache;
  if (!allHist || !S.positions.length) return;

  // Build chronological list of all unique dates across all held symbols
  const dateSet = new Set();
  S.positions.forEach(pos => {
    (allHist[pos.symbol] || []).forEach(d => dateSet.add(d.date));
  });
  const allDates = Array.from(dateSet).sort();
  if (allDates.length < 2) return;

  // Build lookup: date → { sym → close }
  const lookup = {};
  S.positions.forEach(pos => {
    (allHist[pos.symbol] || []).forEach(d => {
      if (!lookup[d.date]) lookup[d.date] = {};
      lookup[d.date][pos.symbol] = d.close;
    });
  });

  // Portfolio value per date (only dates where ALL positions have data)
  const portByDate = {};
  allDates.forEach(date => {
    const dayData = lookup[date] || {};
    const val = S.positions.reduce((s, pos) => {
      const c = dayData[pos.symbol];
      return c != null ? s + c * pos.shares : s;
    }, 0);
    if (val > 0) portByDate[date] = val;
  });
  const dates = allDates.filter(d => portByDate[d] != null);
  if (dates.length < 2) return;

  // Rolling return for window W days: return[i] = portVal[i] / portVal[j] - 1
  // where j = the nearest date at least W calendar days before dates[i]
  const computeRolling = (w) => {
    return dates.map((date, i) => {
      const cutoff = new Date(date + 'T00:00:00');
      cutoff.setDate(cutoff.getDate() - w);
      const cutoffStr = cutoff.toISOString().slice(0, 10);
      // Find latest date at or before cutoff
      let j = i - 1;
      while (j >= 0 && dates[j] > cutoffStr) j--;
      if (j < 0 || portByDate[dates[j]] == null) return null;
      return (portByDate[date] / portByDate[dates[j]] - 1) * 100;
    });
  };

  const r30  = computeRolling(30);
  const r90  = computeRolling(90);
  const r365 = computeRolling(365);

  // Only show if we have some non-null data
  const hasData = r365.some(v => v != null) || r90.some(v => v != null) || r30.some(v => v != null);
  const card = $('rolling-card');
  if (!hasData) { if (card) card.style.display = 'none'; return; }
  if (card) card.style.display = '';

  const labels = dates.map(d =>
    new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  );

  if (S.charts.rolling) { S.charts.rolling.destroy(); S.charts.rolling = null; }
  const canvas = $('c-rolling');
  if (!canvas) return;

  S.charts.rolling = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label:'30-day',  data:r30,  borderColor:'rgba(91,138,240,.9)',  borderWidth:1.5, pointRadius:0, fill:false, tension:.3, spanGaps:true },
        { label:'90-day',  data:r90,  borderColor:'rgba(20,240,168,.85)', borderWidth:1.5, pointRadius:0, fill:false, tension:.3, spanGaps:true },
        { label:'365-day', data:r365, borderColor:'rgba(240,192,91,.85)', borderWidth:2,   pointRadius:0, fill:false, tension:.3, spanGaps:true },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display:true, labels:{ boxWidth:12, font:{size:11}, color:'#5a6680', usePointStyle:true, pointStyleWidth:16 } },
        tooltip: { ...TT, callbacks: { label: c => ` ${c.dataset.label}: ${c.parsed.y != null ? f.pct(c.parsed.y) : '—'}` } },
      },
      scales: {
        x: { grid:{display:false}, ticks:{maxTicksLimit:6, font:{size:9}} },
        y: { position:'right', grid:{color:'rgba(255,255,255,0.04)'}, ticks:{font:{size:9}, callback:v => f.pct(v,1)},
          afterDataLimits: axis => { axis.max = Math.max(axis.max, 1); axis.min = Math.min(axis.min, -1); },
        },
      },
    },
  });
}

// ── PORTFOLIO CORRELATION ──────────────────────────────────────
function _renderCorrelation() {
  const card = $('corr-card');
  const allHist = _statsHistCache;
  if (!allHist || !card) return;

  // Build daily return series per symbol using full history (not period-filtered)
  const symsWithData = S.positions.map(p => p.symbol).filter(sym => {
    const h = allHist[sym] || [];
    return h.length >= 10;
  });

  if (symsWithData.length < 2) { card.style.display = 'none'; return; }

  // Build date-aligned return series
  const allDates = Array.from(
    new Set(symsWithData.flatMap(sym => (allHist[sym] || []).map(d => d.date)))
  ).sort();

  // close lookup per symbol
  const closeMap = {};
  symsWithData.forEach(sym => {
    closeMap[sym] = {};
    (allHist[sym] || []).forEach(d => { closeMap[sym][d.date] = d.close; });
  });

  // Daily return for each date (skip first date — no previous)
  const returns = {};
  symsWithData.forEach(sym => { returns[sym] = []; });
  for (let i = 1; i < allDates.length; i++) {
    const d = allDates[i], dPrev = allDates[i - 1];
    symsWithData.forEach(sym => {
      const c = closeMap[sym][d], cp = closeMap[sym][dPrev];
      returns[sym].push(c != null && cp != null && cp > 0 ? (c / cp - 1) : null);
    });
  }

  // Pearson correlation between two series (skip null pairs)
  function pearson(a, b) {
    const pairs = a.map((v, i) => [v, b[i]]).filter(([x, y]) => x != null && y != null);
    if (pairs.length < 5) return null;
    const n = pairs.length;
    const mx = pairs.reduce((s, [x]) => s + x, 0) / n;
    const my = pairs.reduce((s, [, y]) => s + y, 0) / n;
    let num = 0, dx2 = 0, dy2 = 0;
    pairs.forEach(([x, y]) => { const dx = x - mx, dy = y - my; num += dx * dy; dx2 += dx * dx; dy2 += dy * dy; });
    const denom = Math.sqrt(dx2 * dy2);
    return denom === 0 ? null : num / denom;
  }

  const n = symsWithData.length;
  const matrix = symsWithData.map((symA, i) =>
    symsWithData.map((symB, j) => {
      if (i === j) return 1;
      return pearson(returns[symA], returns[symB]);
    })
  );

  // Color interpolation: -1 → loss, 0 → neutral, +1 → gain
  function corrColor(v) {
    if (v == null) return 'var(--border)';
    if (v === 1)  return 'rgba(20,240,168,.35)';
    if (v >= 0) {
      const t = v;
      return `rgba(20,240,168,${(t * 0.6).toFixed(2)})`;
    } else {
      const t = -v;
      return `rgba(240,72,110,${(t * 0.6).toFixed(2)})`;
    }
  }

  const cellSize = Math.max(36, Math.min(60, Math.floor(420 / n)));
  const headerCells = symsWithData.map(sym =>
    `<div style="width:${cellSize}px;font-size:9px;font-weight:600;color:var(--muted);text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${sym}</div>`
  ).join('');

  const rows = matrix.map((row, i) => {
    const cells = row.map((v, j) => {
      const label = v != null ? f.num(v, 2) : '—';
      const bg    = corrColor(v);
      return `<div style="width:${cellSize}px;height:${cellSize}px;background:${bg};border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:10px;font-family:var(--mono);cursor:default" title="${symsWithData[i]} vs ${symsWithData[j]}: ${label}">${label}</div>`;
    }).join('');
    return `<div style="display:flex;gap:4px;align-items:center">
      <div style="width:44px;font-size:9px;font-weight:600;color:var(--muted);text-align:right;padding-right:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${symsWithData[i]}</div>
      ${cells}
    </div>`;
  }).join('');

  card.style.display = '';
  card.innerHTML = `
    <div class="chart-title" style="margin-bottom:16px">Portfolio Correlation</div>
    <div style="display:grid;grid-template-columns:auto 1fr;gap:20px;align-items:start">
      <div style="overflow-x:auto">
        <div style="display:inline-block">
          <div style="display:flex;gap:4px;margin-bottom:4px;padding-left:50px">${headerCells}</div>
          <div style="display:flex;flex-direction:column;gap:4px">${rows}</div>
        </div>
      </div>
      <div style="display:flex;flex-direction:column;gap:12px;height:100%">
        <div style="background:var(--adim);border:1px solid var(--ba);border-radius:10px;padding:14px 16px">
          <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:10px">Color Scale</div>
          <div style="height:10px;border-radius:6px;background:linear-gradient(to right,rgba(240,72,110,.6),rgba(255,255,255,.08),rgba(20,240,168,.6));margin-bottom:6px"></div>
          <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--muted)">
            <span style="color:#f0486e">-1.0 inverse</span>
            <span>0 none</span>
            <span style="color:#14f0a8">+1.0 identical</span>
          </div>
        </div>
        <div style="background:var(--adim);border:1px solid var(--ba);border-radius:10px;padding:14px 16px;flex:1">
          <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:10px">How to use this</div>
          <div style="display:flex;flex-direction:column;gap:8px;font-size:12px;color:var(--muted);line-height:1.6">
            <div>Each cell is the correlation between two positions' daily returns — how closely they move together.</div>
            <div><span style="color:#14f0a8;font-weight:600">Deep green</span> positions move in lockstep. A bad day for one likely hurts the other — your portfolio is concentrated.</div>
            <div><span style="color:#f0486e;font-weight:600">Red</span> positions move in opposite directions — they naturally hedge each other.</div>
            <div><strong style="color:var(--text)">Near 0</strong> means little relationship — healthy diversification.</div>
            <div style="padding-top:4px;border-top:1px solid var(--ba)">If most cells are deep green, consider adding uncorrelated assets (bonds, international stocks, commodities) to spread risk.</div>
          </div>
        </div>
      </div>
    </div>`;
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

// ── WHAT-IF SIMULATOR ──────────────────────────────────────────
async function runWhatIf() {
  const symInput = $('wi-symbol');
  const amtInput = $('wi-amount');
  const result   = $('wi-result');
  if (!symInput || !amtInput || !result) return;

  const sym    = symInput.value.trim().toUpperCase().replace(/[^A-Z0-9.-]/g, '');
  const amount = parseFloat(amtInput.value);

  if (!sym) { toast('Enter a symbol', 'error'); return; }
  if (!amount || amount <= 0) { toast('Enter an amount', 'error'); return; }

  result.innerHTML = '<div class="spinner-wrap" style="padding:20px"><div class="spinner"></div></div>';

  // Get current price — try cache first, then fetch
  let quote = S.quotes[sym];
  if (!quote?.price) {
    try { quote = await API._oneQuote(sym); if (quote) S.quotes[sym] = quote; }
    catch(e) {}
  }
  const price = quote?.price;
  if (!price) {
    result.innerHTML = `<p style="color:var(--loss);font-size:13px">Could not find price for ${sym}. Check your API key in Settings.</p>`;
    return;
  }

  const newShares   = amount / price;
  const portVal     = Port.value();
  const existing    = S.positions.find(p => p.symbol === sym);
  const existShares = existing?.shares ?? 0;
  const existVal    = price * existShares;
  const newPosVal   = existVal + amount;
  const newPortTotal= portVal + amount;

  const oldAlloc    = portVal > 0 ? (existVal    / portVal)     * 100 : 0;
  const newAlloc    = newPortTotal > 0 ? (newPosVal / newPortTotal) * 100 : 0;
  const targetW     = existing?.target_weight ?? 0;

  const annualDiv   = quote?.dividendYield ? price * quote.dividendYield : null;
  const oldIncome   = annualDiv != null ? annualDiv * existShares : null;
  const newIncome   = annualDiv != null ? annualDiv * (existShares + newShares) : null;
  const incomeDelta = oldIncome != null ? newIncome - oldIncome : null;

  const totalShares = existShares + newShares;
  const newAvgCost  = existShares > 0
    ? ((existShares * (existing?.avg_cost ?? price)) + (newShares * price)) / totalShares
    : price;

  const fmt$ = n => n == null ? '—' : f.$(n);
  const fmtPct = n => n == null ? '—' : f.pct(n, 2);
  const gc  = (n, negate) => {
    const v = negate ? -n : n;
    return v >= 0 ? 'var(--gain)' : 'var(--loss)';
  };

  result.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
      <div>
        <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:10px">Before</div>
        <div class="res-item"><div class="rl">Shares held</div><div class="rv">${f.num(existShares, existShares % 1 === 0 ? 0 : 4)}</div></div>
        <div class="res-item"><div class="rl">${sym} allocation</div><div class="rv">${fmtPct(oldAlloc)}</div></div>
        ${targetW > 0 ? `<div class="res-item"><div class="rl">Target weight</div><div class="rv">${fmtPct(targetW)}</div></div>` : ''}
        ${oldIncome != null ? `<div class="res-item"><div class="rl">Annual income</div><div class="rv">${fmt$(oldIncome)}</div></div>` : ''}
        <div class="res-item"><div class="rl">Portfolio total</div><div class="rv">${fmt$(portVal)}</div></div>
      </div>
      <div>
        <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--accent);margin-bottom:10px">After (+${fmt$(amount)})</div>
        <div class="res-item"><div class="rl">Shares held</div><div class="rv" style="color:var(--accent)">${f.num(totalShares, totalShares % 1 === 0 ? 0 : 4)}</div></div>
        <div class="res-item"><div class="rl">${sym} allocation</div><div class="rv" style="color:${gc(newAlloc - oldAlloc)}">${fmtPct(newAlloc)}</div></div>
        ${targetW > 0 ? `<div class="res-item"><div class="rl">vs target</div><div class="rv" style="color:${gc(newAlloc - targetW, true)}">${newAlloc >= targetW ? '+' : ''}${f.num(newAlloc - targetW, 2)}pp</div></div>` : ''}
        ${newIncome != null ? `<div class="res-item"><div class="rl">Annual income</div><div class="rv" style="color:var(--gain)">${fmt$(newIncome)} <span style="font-size:10px;color:var(--muted)">(+${fmt$(incomeDelta)})</span></div></div>` : ''}
        <div class="res-item"><div class="rl">Portfolio total</div><div class="rv" style="color:var(--accent)">${fmt$(newPortTotal)}</div></div>
      </div>
    </div>
    <div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--border);display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <div style="font-size:12px;color:var(--muted)">Buying <strong style="color:var(--text)">${f.num(newShares, newShares >= 10 ? 2 : 4)} sh</strong> of ${sym} @ ${fmt$(price)} · New avg cost: <strong style="color:var(--text)">${fmt$(newAvgCost)}</strong></div>
      <button class="btn btn-ghost" style="font-size:11px;padding:5px 10px;white-space:nowrap" onclick="showTradeModal('${sym}');document.getElementById('trade-price').value='${price.toFixed(4)}';document.getElementById('trade-shares').value='${(amount/price).toFixed(4)}';_updateTradePreview()">Add to Portfolio →</button>
    </div>`;
}

// ── REBALANCE ──────────────────────────────────────────────────
function computeAllocation(deposit) {
  const rows     = Port.rows();
  const newTotal = Port.value() + deposit;

  const withGap = rows.map(h => {
    const currentVal = h.val ?? 0;
    const gap = h.targetWeight > 0
      ? Math.max(0, (h.targetWeight / 100) * newTotal - currentVal)
      : 0;
    return { ...h, gap };
  });

  const totalGap = withGap.reduce((s, h) => s + h.gap, 0);
  const factor   = totalGap > 0 ? Math.min(1, deposit / totalGap) : 0;

  return {
    rows: withGap.map(h => ({
      ...h,
      allocDollars: h.gap * factor,
      allocShares:  h.px > 0 ? (h.gap * factor) / h.px : 0,
    })),
    totalGap,
    totalAllocated: withGap.reduce((s, h) => s + h.gap * factor, 0),
    unallocated: deposit - withGap.reduce((s, h) => s + h.gap * factor, 0),
  };
}

function renderRebalance() {
  const container = $('reb-results');
  if (!container) return;

  const deposit = parseFloat($('reb-amount')?.value) || 0;
  const rows = Port.rows();

  if (!rows.length) {
    container.innerHTML = `<div style="color:var(--muted);font-size:13px;text-align:center;padding:20px">No positions in this portfolio.</div>`;
    return;
  }

  const hasTargets = rows.some(h => h.targetWeight > 0);
  if (!hasTargets) {
    container.innerHTML = `<div style="color:var(--muted);font-size:13px;text-align:center;padding:20px">Set target weights on positions in Settings (⚙) to use this feature.</div>`;
    return;
  }

  if (deposit <= 0) {
    container.innerHTML = `<div style="color:var(--muted);font-size:13px;text-align:center;padding:20px">Enter a deposit amount to see suggested buys.</div>`;
    return;
  }

  const { rows: alloc, totalAllocated, unallocated } = computeAllocation(deposit);

  const renderRow = (h, isClassed = false) => {
    const dim        = h.allocDollars < 0.01;
    const dollarStr  = h.allocDollars >= 0.01 ? f.$(h.allocDollars) : '—';
    const sharesStr  = h.allocShares  > 0     ? h.allocShares.toFixed(2) : '—';
    const currentPct = h.weight     != null   ? f.pct(h.weight, 1) : '—';
    const targetPct  = h.targetWeight > 0     ? f.pct(h.targetWeight, 1) : '—';
    const cls = [dim ? 'reb-dim' : '', isClassed ? 'classed' : ''].filter(Boolean).join(' ');
    return `
      <tr class="${cls}">
        <td>
          <span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${h.color};margin-right:8px;vertical-align:middle"></span>
          <span style="font-weight:600">${h.symbol}</span>
        </td>
        <td>${currentPct}</td>
        <td>${targetPct}</td>
        <td>${dollarStr}</td>
        <td>${sharesStr}</td>
      </tr>`;
  };

  let bodyHTML = '';
  if (!S.classes.length) {
    bodyHTML = alloc.map(h => renderRow(h)).join('');
  } else {
    const ungrouped = alloc.filter(h => !h.cls);
    if (ungrouped.length) {
      bodyHTML += `<tr class="class-header-row"><td colspan="5"><span class="class-name" style="color:var(--muted)">Ungrouped</span></td></tr>`;
      bodyHTML += ungrouped.map(h => renderRow(h, false)).join('');
    }
    for (const cls of S.classes) {
      const clsRows  = alloc.filter(h => h.cls?.id === cls.id);
      if (!clsRows.length) continue;
      const clsAlloc = clsRows.reduce((s, h) => s + h.allocDollars, 0);
      bodyHTML += `
        <tr class="class-header-row">
          <td colspan="5">
            <span class="class-badge" style="background:${cls.color || '#5a6680'}"></span>
            <span class="class-name">${cls.name}</span>
            ${clsAlloc >= 0.01 ? `<span class="mono" style="margin-left:16px;font-size:12px">${f.$(clsAlloc)}</span>` : ''}
          </td>
        </tr>`;
      bodyHTML += clsRows.map(h => renderRow(h, true)).join('');
    }
  }

  let footerHTML = '';
  if (unallocated > 0.01) {
    footerHTML += `
      <tr>
        <td style="color:var(--muted)">Unallocated</td>
        <td colspan="2" style="color:var(--muted);font-size:11px;font-family:var(--sans)">All targets met</td>
        <td class="mono" style="color:var(--muted)">${f.$(unallocated)}</td>
        <td>—</td>
      </tr>`;
  }
  footerHTML += `
    <tr class="reb-total">
      <td style="font-weight:600;font-family:var(--sans)">Total</td>
      <td colspan="2"></td>
      <td class="mono" style="color:var(--accent)">${f.$(totalAllocated)}</td>
      <td></td>
    </tr>`;

  container.innerHTML = `
    <table class="reb-tbl">
      <thead>
        <tr>
          <th>Symbol</th>
          <th>Current %</th>
          <th>Target %</th>
          <th>Buy ($)</th>
          <th>~ Shares</th>
        </tr>
      </thead>
      <tbody>${bodyHTML}${footerHTML}</tbody>
    </table>`;
}

function scheduleRebalance() {
  clearTimeout(_rebTimer);
  _rebTimer = setTimeout(renderRebalance, 300);
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
    
    const limitWarning = !isPremium() && S.portfolios.length >= FREE_LIMITS.portfolios
      ? `<div style="background:rgba(240,72,110,.08);border:1px solid rgba(240,72,110,.25);border-radius:8px;padding:12px;margin-bottom:16px;font-size:12px;color:var(--muted);text-align:center">
           <span style="color:var(--loss);font-weight:600">Limit reached:</span> Free plan allows ${FREE_LIMITS.portfolios} portfolio.
           <a onclick="closeOverlay('ov-folio');showUpgradeModal('portfolio')" style="color:var(--accent);cursor:pointer;font-weight:600;margin-left:4px">Upgrade →</a>
         </div>`
      : '';
    
    if (!S.portfolios.length) {
      list.innerHTML = limitWarning + '<p style="color:var(--muted);font-size:13px;text-align:center;padding:20px">No portfolios yet. Create one below.</p>';
      return;
    }
    list.innerHTML = limitWarning + S.portfolios.map(p => `
      <div class="folio-item ${p.id === S.currentFolioId ? 'active' : ''}" data-id="${p.id}">
        <div>
          <div class="fi-name">${esc(p.name)}</div>
          <div class="fi-meta">Created ${new Date(p.created_at).toLocaleDateString()}</div>
        </div>
        <div class="folio-actions">
          ${p.id !== S.currentFolioId
            ? `<button class="btn btn-sm folio-select" data-id="${p.id}">Select</button>`
            : '<span style="font-size:11px;color:var(--accent);font-weight:600">Active</span>'}
          <button class="btn btn-sm btn-danger folio-delete" data-id="${p.id}" data-name="${esc(p.name)}">Delete</button>
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
    list.innerHTML = `<p style="color:var(--loss);font-size:13px;padding:16px">Could not load portfolios</p>`;
  }
}

function selectFolio(id) {
  S.currentFolioId = id;
  localStorage.setItem('dividnd_current_id', id);
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
      localStorage.removeItem('dividnd_current_id');
      updateFolioPill(); renderDash(); renderHoldings();
    }
    toast('Portfolio deleted');
    await renderFolioList();
  } catch(e) { /* already handled in DB layer */ }
}

// ── PLAN / UPGRADE ─────────────────────────────────────────────
async function loadPlan() {
  try {
    const data = await proxyFetch('/api/subscription');
    S.plan = data?.plan || 'free';
  } catch(e) { 
    console.error('[DIVIDND] loadPlan error:', e);
    S.plan = 'free'; 
  }
  updatePlanUI();
}

function updatePlanUI() {
  const badge = $('plan-badge');
  if (badge) {
    badge.textContent = isPremium() ? 'Premium' : 'Free';
    badge.className   = `plan-badge ${isPremium() ? 'premium' : 'free'}`;
  }
  const actionBtn = $('plan-action-btn');
  if (actionBtn) {
    actionBtn.textContent = isPremium() ? 'Manage Billing' : 'Upgrade to Premium';
    actionBtn.onclick = isPremium() ? openBillingPortal : () => showUpgradeModal('portfolio');
  }
  // Update profile avatar to reflect plan (accent ring = premium)
  const avatarBtn = $('btn-profile');
  if (avatarBtn) {
    avatarBtn.style.background = isPremium() ? 'rgba(20,240,168,0.2)' : 'rgba(255,255,255,0.1)';
    avatarBtn.style.color      = isPremium() ? 'var(--accent)' : 'var(--text)';
    avatarBtn.style.boxShadow  = isPremium() ? '0 0 0 1.5px var(--accent)' : 'none';
  }
  updateLimitsDisplay();

  // One-time premium upgrade celebration
  // Fires only when: plan is premium, last seen plan was 'free', and not yet celebrated
  const planSeen = localStorage.getItem('dividnd_plan_seen');
  if (isPremium() && planSeen === 'free' && !localStorage.getItem('dividnd_celebrated')) {
    // Small delay so the dashboard renders first
    setTimeout(showPremiumCelebration, 600);
  }
  localStorage.setItem('dividnd_plan_seen', S.plan);
}

function showPremiumCelebration() {
  localStorage.setItem('dividnd_celebrated', '1');
  localStorage.setItem('dividnd_plan_seen', 'premium');
  _burstConfetti();
  const ov = $('ov-celebrate');
  if (!ov) return;
  ov.classList.add('open');
}

function _burstConfetti() {
  const colors = ['#14f0a8','#5b8af0','#f0c05b','#f05b8a','#a05bf0','#5be8f0','#f0905b'];
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:9998;overflow:hidden';
  for (let i = 0; i < 70; i++) {
    const el    = document.createElement('div');
    const color = colors[i % colors.length];
    const x     = Math.random() * 100;
    const delay = Math.random() * 1000;
    const dur   = 2200 + Math.random() * 1800;
    const size  = 6 + Math.random() * 7;
    const drift = (Math.random() - 0.5) * 300;
    const rot   = Math.random() * 900;
    const round = Math.random() > 0.5;
    el.style.cssText = `position:absolute;left:${x}vw;top:-16px;width:${size}px;height:${size * (round ? 1 : 0.45)}px;background:${color};border-radius:${round ? '50%' : '3px'};opacity:1`;
    el.animate(
      [{ transform: `translateY(0) translateX(0) rotate(0deg)`, opacity: 1 },
       { transform: `translateY(105vh) translateX(${drift}px) rotate(${rot}deg)`, opacity: 0 }],
      { duration: dur, delay, easing: 'ease-in', fill: 'forwards' }
    );
    wrap.appendChild(el);
  }
  document.body.appendChild(wrap);
  setTimeout(() => wrap.remove(), 5500);
}

function showProfileModal() {
  const email = S.user?.email || '';
  const meta  = S.user?.user_metadata || {};
  const name  = meta.full_name || meta.name || '';
  const initial = (name || email).charAt(0).toUpperCase() || '?';

  const avatarEl = $('profile-avatar');
  if (avatarEl) avatarEl.textContent = initial;

  const nameEl = $('profile-name');
  if (nameEl) nameEl.textContent = name || email;

  const emailEl = $('profile-email');
  if (emailEl) emailEl.textContent = name ? email : '';

  const planBadge = $('profile-plan-badge');
  if (planBadge) {
    planBadge.textContent = isPremium() ? 'Premium' : 'Free';
    planBadge.className   = `plan-badge ${isPremium() ? 'premium' : 'free'}`;
  }

  const features = $('profile-plan-features');
  if (features) {
    if (isPremium()) {
      features.innerHTML = `
        <div style="display:grid;gap:6px">
          <span>✓ Unlimited portfolios</span>
          <span>✓ Unlimited positions</span>
          <span>✓ Sub-classes & target weights</span>
          <span>✓ Trade lot tracking</span>
          <span>✓ All future features included</span>
        </div>`;
    } else {
      features.innerHTML = `
        <div style="display:grid;gap:6px;margin-bottom:10px">
          <span>✗ 1 portfolio · 5 positions</span>
          <span style="color:rgba(255,255,255,0.3)">✗ Sub-classes locked</span>
          <span style="color:rgba(255,255,255,0.3)">✗ Unlimited positions locked</span>
        </div>
        <div style="font-size:11px;color:var(--accent)">Upgrade for $7/mo to unlock everything →</div>`;
    }
  }

  $('profile-upgrade-btn-wrap').style.display = isPremium() ? 'none' : '';
  $('profile-billing-btn-wrap').style.display  = isPremium() ? '' : 'none';

  $('ov-profile').classList.add('open');
}

function showUpgradeModal(reason) {
  const msgs = {
    portfolio: 'Track your RRSP, TFSA, and trading accounts separately — or consolidate everything in one view.',
    position:  'Add all your holdings without worrying about limits. Track your entire portfolio.',
    subclass:  'Organize positions by asset class (Equities, Bonds, ETFs) for better portfolio insight.',
  };
  const titles = {
    portfolio: 'You\'ve reached your portfolio limit',
    position:  'You\'ve reached your position limit',
    subclass:  'Unlock Sub-Classes & Target Weights',
  };
  const { portRem, posRem } = getLimitsRemaining();
  
  $('upg-limit-title').textContent = titles[reason] || titles.portfolio;
  $('upg-limit-detail').textContent = isPremium() 
    ? 'You\'re on Premium' 
    : `Free plan: ${FREE_LIMITS.portfolios} portfolio, ${FREE_LIMITS.positions} positions`;
  $('upgrade-body').textContent = msgs[reason] || msgs.portfolio;
  $('ov-upgrade').classList.add('open');
}

let _upgradeMode = 'monthly';
function setUpgradeToggle(mode) {
  _upgradeMode = mode;
  $('upg-monthly').classList.toggle('active', mode === 'monthly');
  $('upg-annual').classList.toggle('active',  mode === 'annual');
  if (mode === 'annual') {
    $('upg-price').innerHTML      = '$4.92<span>/month</span>';
    $('upg-billing').textContent  = 'Billed $59/year — save $25';
  } else {
    $('upg-price').innerHTML      = '$7<span>/month</span>';
    $('upg-billing').textContent  = 'Billed monthly';
  }
}

async function handleCheckout() {
  const priceId = _upgradeMode === 'annual'
    ? import.meta.env.VITE_STRIPE_PRICE_ANNUAL
    : import.meta.env.VITE_STRIPE_PRICE_MONTHLY;
  const btn = $('btn-checkout');
  btn.textContent = 'Redirecting…';
  btn.disabled    = true;
  try {
    const { url } = await proxyFetch('/api/checkout', {}, 'POST', {
      priceId,
      successUrl: window.location.origin + '/dashboard.html?upgraded=1',
      cancelUrl:  window.location.href,
    });
    window.location.href = url;
  } catch(e) {
    toast('Could not start checkout. Please try again.', 'error');
    btn.textContent = 'Upgrade to Premium';
    btn.disabled    = false;
  }
}

async function openBillingPortal() {
  try {
    const { url } = await proxyFetch('/api/portal', {}, 'POST', {
      returnUrl: window.location.origin + '/dashboard.html',
    });
    window.location.href = url;
  } catch(e) { toast('Could not open billing portal.', 'error'); }
}

// ── ONBOARDING FLOW ────────────────────────────────────────────
let _onboardFolioId = null;

function showOnboarding() {
  _onboardFolioId = null;
  // Reset to step 1
  ['onb-step-1','onb-step-2','onb-step-3'].forEach((id, i) =>
    $(`${id}`) && ($(`${id}`).style.display = i === 0 ? '' : 'none')
  );
  document.querySelectorAll('.onb-dot').forEach((d, i) =>
    d.classList.toggle('active', i === 0)
  );
  const input = $('onb-folio-name');
  if (input) input.value = 'My Portfolio';
  $('ov-onboarding').classList.add('open');
}

function _onbSetStep(n) {
  ['onb-step-1','onb-step-2','onb-step-3'].forEach((id, i) => {
    const el = $(id); if (el) el.style.display = i === n - 1 ? '' : 'none';
  });
  document.querySelectorAll('.onb-dot').forEach((d, i) =>
    d.classList.toggle('active', i < n)
  );
}

function _dismissOnboarding() {
  localStorage.setItem('dividnd_onboarded', '1');
  closeOverlay('ov-onboarding');
}

async function _onbGoStep2() {
  const nameInput = $('onb-folio-name');
  const name = nameInput?.value.trim() || '';
  if (!name) { if (nameInput) { nameInput.style.borderColor = 'var(--loss)'; nameInput.focus(); } return; }
  if (nameInput) nameInput.style.borderColor = '';
  const btn = $('btn-onb-step1');
  if (btn) btn.textContent = 'Creating…';
  try {
    const folio = await DB.createPortfolio(name);
    _onboardFolioId = folio.id;
    S.portfolios.push(folio);
    S.currentFolioId = folio.id;
    localStorage.setItem('dividnd_current_id', folio.id);
    updateFolioPill();
    _onbSetStep(2);
    $('onb-sym')?.focus();
  } catch(e) {
    toast('Could not create portfolio: ' + e.message, 'error');
  } finally {
    if (btn) btn.textContent = 'Continue →';
  }
}

async function _onbGoStep3() {
  const sym    = $('onb-sym')?.value.trim().toUpperCase().replace(/[^A-Z0-9.-]/g,'') || '';
  const shares = parseFloat($('onb-shares')?.value);
  const cost   = parseFloat($('onb-cost')?.value);
  if (!sym || !shares || shares <= 0 || !cost || cost <= 0) {
    toast('Enter symbol, shares, and average cost', 'error'); return;
  }
  if (!_onboardFolioId) { _dismissOnboarding(); return; }
  const btn = $('btn-onb-step2');
  if (btn) btn.textContent = 'Adding…';
  try {
    await DB.upsertPosition(_onboardFolioId, sym, shares, cost, COLORS[0], 0, null);
    S.positions = await DB.listPositions(_onboardFolioId);
    renderDash(); renderHoldings();
    _onbSetStep(3);
  } catch(e) {
    toast('Could not add position: ' + e.message, 'error');
  } finally {
    if (btn) btn.textContent = 'Add Position →';
  }
}

// ── CREATE PORTFOLIO MODAL ──────────────────────────────────────
function openCreateFolioModal() {
  if (!isPremium() && S.portfolios.length >= FREE_LIMITS.portfolios) {
    showUpgradeModal('portfolio');
    return;
  }
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

  if (!isPremium() && S.portfolios.length >= FREE_LIMITS.portfolios) {
    showUpgradeModal('portfolio');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Creating…';
  try {
    const folio = await DB.createPortfolio(name);
    S.portfolios.push(folio);
    S.currentFolioId = folio.id;
    S.positions = [];
    localStorage.setItem('dividnd_current_id', folio.id);
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
function updateCurrencyButtons() {
  $('set-currency-usd')?.classList.toggle('cad', S.currency === 'USD');
  $('set-currency-cad')?.classList.toggle('cad', S.currency === 'CAD');
}

function openSettings() {
  updateCurrencyButtons();
  updatePlanUI();
  $('ov-settings').classList.add('open');
}

function openPositions() {
  const folio = S.portfolios.find(p => p.id === S.currentFolioId);
  $('positions-folio-name').textContent = folio ? `— ${folio.name}` : '';
  editorClasses     = S.classes.map(c => ({ ...c }));
  _originalClassIds = S.classes.map(c => c.id);
  _deletedClassIds  = [];
  editorRows = S.positions.map(p => ({ ...p }));
  
  if (!isPremium()) {
    const { posRem } = getLimitsRemaining();
    const hint = $('positions-limit-hint');
    if (hint) {
      if (posRem === 0) {
        hint.textContent = `· ${FREE_LIMITS.positions}/${FREE_LIMITS.positions} positions used`;
        hint.style.color = 'var(--loss)';
      } else {
        hint.textContent = `· ${FREE_LIMITS.positions - posRem}/${FREE_LIMITS.positions} positions used`;
        hint.style.color = 'var(--muted)';
      }
    }
  } else {
    const hint = $('positions-limit-hint');
    if (hint) {
      hint.textContent = '';
    }
  }

  // Show/hide sub-class editor based on plan
  const classSection = $('classes-section-wrap');
  const classLock    = $('classes-lock');
  if (classSection) classSection.style.display = isPremium() ? '' : 'none';
  if (classLock)    classLock.style.display     = isPremium() ? 'none' : '';

  if (isPremium()) renderClassEditor();
  renderEditor();
  $('ov-positions').classList.add('open');
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

  // Sort: ungrouped first (no class → ''), then alphabetically by class name, then market value desc within group
  editorRows.sort((a, b) => {
    const aName = (editorClasses.find(c => c.id === a.class_id)?.name ?? '').toLowerCase();
    const bName = (editorClasses.find(c => c.id === b.class_id)?.name ?? '').toLowerCase();
    if (aName !== bName) return aName.localeCompare(bName);
    const aVal = (S.quotes[a.symbol]?.price ?? 0) * a.shares;
    const bVal = (S.quotes[b.symbol]?.price ?? 0) * b.shares;
    return bVal - aVal;
  });

  ed.innerHTML = editorRows.map((h, i) => `
    <div class="h-row" data-i="${i}">
      <input type="text" class="hs" placeholder="AAPL" value="${h.symbol}" style="text-transform:uppercase">
      <input type="number" class="hq" placeholder="Shares" value="${h.shares}" min="0" step="any">
      <input type="number" class="hc" placeholder="Avg $" value="${h.avg_cost}" min="0" step="any">
      <input type="number" class="ht" placeholder="10" value="${typeof h.target_weight === 'number' ? h.target_weight : 0}" min="0" max="100" step="0.1" title="Direct portfolio % (ungrouped) or intra-class % (when assigned to a class)">
      <input type="number" class="htp" placeholder="Alert $" value="${h.target_price ?? ''}" min="0" step="any" title="Price target alert — toast fires when price reaches this">
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

function saveSettings() {
  closeOverlay('ov-settings');
}

async function savePositions() {
  if (!S.currentFolioId) { closeOverlay('ov-positions'); return; }

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
    const sym        = r.querySelector('.hs').value.trim().toUpperCase();
    const shares     = parseFloat(r.querySelector('.hq').value);
    const cost       = parseFloat(r.querySelector('.hc').value);
    const target     = parseFloat(r.querySelector('.ht').value);
    const targetPriceRaw = r.querySelector('.htp')?.value;
    const tp         = targetPriceRaw && targetPriceRaw !== '' ? parseFloat(targetPriceRaw) : null;
    const classId    = r.querySelector('.hcls')?.value || null;
    if (sym && shares >= 0 && cost >= 0) {
      const existing = S.positions.find(p => p.symbol === sym);
      const color    = existing?.color || COLORS[i % COLORS.length];
      const tw       = isNaN(target) ? 0 : target;
      if (classId) {
        classIntraSums[classId] = (classIntraSums[classId] || 0) + tw;
      } else {
        ungroupedTargetSum += tw;
      }
      editorRows.push({ symbol: sym, shares, avg_cost: cost, folio_id: S.currentFolioId, color, target_weight: tw, class_id: classId || null, target_price: tp });
      posData.push({ sym, shares, cost, color, tw, classId: classId || null, tp });
    }
  });

  // Enforce free-tier position limit
  if (!isPremium() && editorRows.length > FREE_LIMITS.positions) {
    showUpgradeModal('position');
    return;
  }

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
      DB.upsertPosition(S.currentFolioId, p.sym, p.shares, p.cost, p.color, p.tw, p.classId, p.tp)
    ));
    S.positions   = await DB.listPositions(S.currentFolioId);
    S.classes     = await DB.listClasses(S.currentFolioId);
    editorRows    = S.positions.map(p => ({ ...p }));
    editorClasses = S.classes.map(c => ({ ...c }));
    closeOverlay('ov-positions');
    toast('Positions saved');
    loadAll();
  } catch(e) { /* already handled */ }
}

// ── EXPORT / IMPORT ────────────────────────────────────────────
function exportJSON() {
  const folio = S.portfolios.find(p => p.id === S.currentFolioId);
  const blob  = new Blob([JSON.stringify({
    folio:       folio?.name || 'Unknown',
    positions:   S.positions,
    classes:     S.classes,
    exportedAt:  new Date().toISOString(),
  }, null, 2)], { type:'application/json' });
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

    // Re-create classes with fresh IDs; build a map from old ID → new ID
    // so position class_id references can be remapped correctly
    const classIdMap = {};
    if (Array.isArray(data.classes)) {
      for (let i = 0; i < data.classes.length; i++) {
        const cls   = data.classes[i];
        const newId = crypto.randomUUID();
        classIdMap[cls.id] = newId;
        await DB.upsertClass(folio.id, {
          id:           newId,
          name:         cls.name,
          targetWeight: cls.target_weight ?? 0,
          color:        cls.color || null,
          sortOrder:    cls.sort_order ?? i,
        });
      }
    }

    for (const p of data.positions) {
      const remappedClassId = p.class_id ? (classIdMap[p.class_id] || null) : null;
      await DB.upsertPosition(folio.id, p.symbol, p.shares, p.avg_cost ?? p.avgCost ?? 0, p.color, p.target_weight ?? 0, remappedClassId);
    }

    S.portfolios.push(folio);
    S.currentFolioId = folio.id;
    localStorage.setItem('dividnd_current_id', folio.id);
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
  _statsHistCache  = null; // invalidate on every portfolio load
  _divHistCache    = null;
  _overviewFetched = new Set(); // reset so new portfolio re-fetches yield data
  _alertedSyms     = new Set(); // reset price alerts on portfolio switch
  if (!S.currentFolioId) { S.classes = []; renderDash(); renderHoldings(); return; }
  try {
    S.positions = await DB.listPositions(S.currentFolioId);
  } catch(e) { return; }
  try {
    S.classes = await DB.listClasses(S.currentFolioId);
  } catch(e) {
    S.classes = [];
    console.warn('[DIVIDND] Classes unavailable:', e.message);
  }

  renderDash(); renderHoldings();

  const syms = S.positions.map(h => h.symbol);
  if (!syms.length) return;

  // Step 1: DB cache — single fast query, renders immediately with last-known prices
  let hasCached = false;
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
      hasCached = true;
      renderDash();
      renderHoldings();
    }
  } catch(e) {
    // Non-fatal: fall through to API path
  }

  // Step 2: fresh quotes from API — progressive per-batch render, never wipes cached data
  try {
    for (let i = 0; i < syms.length; i += 5) {
      const batch = await Promise.all(
        syms.slice(i, i + 5).map(sym =>
          API._oneQuote(sym).catch(e => { console.error(`[DIVIDND] Quote failed ${sym}:`, e.message); return null; })
        )
      );
      batch.filter(Boolean).forEach(q => { S.quotes[q.symbol] = q; });
      renderDash(); renderHoldings();
      if (i + 5 < syms.length) await sleep(12000);
    }
    const total = Port.value();
    if (total > 0) $('c-start').value = Math.round(total);
    runCalc();
    loadPortChart(S.period).catch(e => console.warn('Port chart:', e.message));
    if (document.querySelector('#tab-rebalance.active')) renderRebalance();
    if (S.showCombined) loadAllPositions().then(() => renderDash());
  } catch(e) {
    // If we have cached data, prices are just stale — don't replace the table
    if (!hasCached) {
      const tbody = $('holdings-body');
      if (tbody) tbody.innerHTML = `
        <tr><td colspan="9">
          <div style="text-align:center;padding:40px">
            <div style="font-size:32px;margin-bottom:12px">⚠️</div>
            <div style="font-weight:600;margin-bottom:6px">Failed to load quotes</div>
            <div style="color:var(--muted);font-size:13px;margin-bottom:16px">${e.message}</div>
            <button class="btn btn-primary" onclick="loadAll()">Retry</button>
          </div>
        </td></tr>`;
    }
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
      localStorage.setItem('dividnd_active_tab', btn.dataset.tab);
      if (btn.dataset.tab === 'calculator') runCalc();
      if (btn.dataset.tab === 'rebalance')  renderRebalance();
      if (btn.dataset.tab === 'dividends')  renderDividends();
      if (btn.dataset.tab === 'watchlist')  renderWatchlist();
      if (btn.dataset.tab === 'stats')      renderStats();
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

  $('set-currency-usd')?.addEventListener('click', () => {
    S.currency = 'USD'; localStorage.setItem('dividnd_currency', 'USD');
    updateCurrencyButtons(); renderDash();
  });
  $('set-currency-cad')?.addEventListener('click', () => {
    S.currency = 'CAD'; localStorage.setItem('dividnd_currency', 'CAD');
    updateCurrencyButtons(); renderDash();
  });

  $('btn-combined')?.addEventListener('click', async () => {
    S.showCombined = !S.showCombined;
    localStorage.setItem('dividnd_combined', S.showCombined);
    if (S.showCombined) await loadAllPositions();
    renderDash();
  });

  $('folio-pill')?.addEventListener('click', openFolioModal);
  $('btn-refresh')?.addEventListener('click', () => {
    const btn = $('btn-refresh');
    if (btn.disabled) return;
    btn.disabled = true;
    Cache.clearQuotes();
    loadAll().finally(() => { btn.disabled = false; });
  });
  // Onboarding flow
  $('btn-onboard-skip')?.addEventListener('click', _dismissOnboarding);
  $('btn-onb-done')?.addEventListener('click', _dismissOnboarding);
  $('onb-folio-name')?.addEventListener('keypress', e => { if (e.key === 'Enter') _onbGoStep2(); });
  $('btn-onb-step1')?.addEventListener('click', _onbGoStep2);
  $('btn-onb-step2')?.addEventListener('click', _onbGoStep3);

  $('btn-settings')?.addEventListener('click', openSettings);
  $('btn-add-pos')?.addEventListener('click', openPositions);
  $('dash-create-btn')?.addEventListener('click', openFolioModal);
  $('btn-create-folio')?.addEventListener('click', openCreateFolioModal);
  $('confirm-create-folio')?.addEventListener('click', confirmCreateFolio);

  $('new-folio-name')?.addEventListener('input', function() { this.classList.remove('error'); });
  $('new-folio-name')?.addEventListener('keypress', function(e) { if (e.key === 'Enter') confirmCreateFolio(); });

  $('save-positions')?.addEventListener('click', savePositions);
  $('add-holding')?.addEventListener('click', () => {
    syncEditorRowsFromDOM();
    if (!isPremium() && editorRows.filter(r => r.symbol).length >= FREE_LIMITS.positions) {
      showUpgradeModal('position');
      return;
    }
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

  $('btn-profile')?.addEventListener('click', showProfileModal);
  $('btn-chart-style')?.addEventListener('click', togglePortChartStyle);
  $('btn-wl-add')?.addEventListener('click', addToWatchlist);
  $('wl-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') addToWatchlist(); });
  $('div-cal-prev')?.addEventListener('click', () => {
    _divCalMonth--; if (_divCalMonth < 0) { _divCalMonth = 11; _divCalYear--; }
    _renderDivCalendar();
  });
  $('div-cal-next')?.addEventListener('click', () => {
    _divCalMonth++; if (_divCalMonth > 11) { _divCalMonth = 0; _divCalYear++; }
    _renderDivCalendar();
  });

  const signOutHandler = async () => {
    await S.db.auth.signOut();
    localStorage.removeItem('dividnd_current_id');
    window.location.href = '/';
  };
  $('btn-logout')?.addEventListener('click', signOutHandler);
  $('profile-signout-btn')?.addEventListener('click', signOutHandler);

  $('btn-export')?.addEventListener('click', exportJSON);
  $('btn-import')?.addEventListener('click', () => $('import-file').click());
  $('import-file')?.addEventListener('change', e => { if (e.target.files[0]) importJSON(e.target.files[0]); });
  $('btn-clear-cache')?.addEventListener('click', Cache.clearQuotes);

  $('reb-amount')?.addEventListener('input', scheduleRebalance);

  document.querySelectorAll('.stats-period-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.stats-period-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _statsPeriod = btn.dataset.p;
      const loadingEl = $('bench-loading');
      if (loadingEl) loadingEl.style.display = '';
      _renderBenchChart();
    });
  });

  document.querySelectorAll('.bench-sym-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const sym = btn.dataset.sym;
      if (sym === _benchmarkSym) return;
      document.querySelectorAll('.bench-sym-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _benchmarkSym = sym;
      const loadingEl = $('bench-loading');
      // Fetch benchmark history if not yet in cache
      if (_statsHistCache && !_statsHistCache[sym]) {
        if (loadingEl) loadingEl.style.display = '';
        try { _statsHistCache[sym] = await API.historical(sym); }
        catch(e) { _statsHistCache[sym] = []; }
      }
      if (loadingEl) loadingEl.style.display = '';
      _renderBenchChart();
    });
  });

  ['trade-shares', 'trade-price', 'trade-date'].forEach(id =>
    $(id)?.addEventListener('input', () => {
      clearTimeout(_tradeTimer);
      _tradeTimer = setTimeout(_updateTradePreview, 200);
    })
  );
  $('btn-submit-trade')?.addEventListener('click', submitTrade);

  $('btn-calc')?.addEventListener('click', runCalc);
  ['c-start','c-monthly','c-return','c-div','c-years'].forEach(id =>
    $(id)?.addEventListener('input', scheduleCalc)
  );

  $('btn-whatif')?.addEventListener('click', runWhatIf);
  $('wi-symbol')?.addEventListener('keydown', e => { if (e.key === 'Enter') runWhatIf(); });
  $('wi-amount')?.addEventListener('keydown', e => { if (e.key === 'Enter') runWhatIf(); });

  ['drip-return', 'drip-years', 'drip-start'].forEach(id =>
    $(id)?.addEventListener('input', () => {
      const divPos = _getDivPositions();
      const portYield = Port.value() > 0 ? (divPos.reduce((s,p) => s + p.annualIncome, 0) / Port.value()) * 100 : 0;
      _renderDripProjection(portYield, divPos.reduce((s,p) => s + p.annualIncome, 0));
    })
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
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    const open = document.querySelector('.overlay.open');
    if (open) closeOverlay(open.id);
  });
}

// ── INIT ─────────────────────────────────────────────────────
async function init() {
  initDB();
  initEvents();

  const { data: { session } } = await S.db.auth.getSession();
  if (!session) { window.location.href = '/auth.html'; return; }
  S.user = session.user;

  // Set profile avatar initial
  const _meta = session.user.user_metadata || {};
  const _name = _meta.full_name || _meta.name || session.user.email || '';
  const _avatarBtn = $('btn-profile');
  if (_avatarBtn) _avatarBtn.textContent = _name.charAt(0).toUpperCase() || '?';

  $('app-shell').style.display = 'block';
  fetchFxRate();
  loadPlan(); // non-blocking — updates UI when resolved
  if (S.showCombined) loadAllPositions().then(() => renderDash());

  try {
    S.portfolios = await DB.listPortfolios();
  } catch(e) {
    toast('Could not load portfolios: ' + e.message, 'error');
    return;
  }

  if (S.currentFolioId && !S.portfolios.find(p => p.id === S.currentFolioId)) {
    S.currentFolioId = null;
    localStorage.removeItem('dividnd_current_id');
  }

  if (!S.currentFolioId && S.portfolios.length) {
    S.currentFolioId = S.portfolios[0].id;
    localStorage.setItem('dividnd_current_id', S.currentFolioId);
  }

  updateFolioPill();
  runCalc();
  await loadAll();

  // Restore last-active tab (default: dashboard)
  const savedTab = localStorage.getItem('dividnd_active_tab') || 'dashboard';
  const savedBtn = document.querySelector(`.nav-btn[data-tab="${savedTab}"]`);
  if (savedBtn && savedTab !== 'dashboard') {
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    savedBtn.classList.add('active');
    $('tab-' + savedTab)?.classList.add('active');
    if (savedTab === 'calculator') runCalc();
    if (savedTab === 'rebalance')  renderRebalance();
    if (savedTab === 'dividends')  renderDividends();
    if (savedTab === 'watchlist')  renderWatchlist();
    if (savedTab === 'stats')      renderStats();
  }

  if (!S.portfolios.length && !localStorage.getItem('dividnd_onboarded'))
    showOnboarding();

  // Post-checkout success redirect — prime the celebration guard so it fires
  // when loadPlan() resolves and updatePlanUI() sees free→premium transition
  if (new URLSearchParams(location.search).get('upgraded') === '1') {
    localStorage.setItem('dividnd_plan_seen', 'free');
    localStorage.removeItem('dividnd_celebrated');
    history.replaceState({}, '', '/dashboard.html');
  }

  S.db.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') {
      localStorage.removeItem('dividnd_current_id');
      window.location.href = '/';
    }
  });
}

// Expose to inline onclick handlers
window.closeOverlay          = closeOverlay;
window.removeFromWatchlist   = removeFromWatchlist;
window.showUpgradeModal = showUpgradeModal;
window.setUpgradeToggle = setUpgradeToggle;
window.handleCheckout   = handleCheckout;
window.showTradeModal      = showTradeModal;
window._setTradeType       = _setTradeType;
window._updateTradePreview = _updateTradePreview;
window.openBillingPortal = openBillingPortal;

init();
