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
  charts:         { port: null, alloc: null, calc: null, stock: null, bench: null, posReturns: null },
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
  if (isPremium()) return;
  const { posRem } = getLimitsRemaining();
  const el = $('pos-remaining');
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
let portChartIsGain = true;

// Debounce handles for calculator and rebalance
let _calcTimer = null;
let _rebTimer  = null;

// Stats tab state
let _statsPeriod    = 'YTD';
let _statsHistCache = null;   // { SYM: [{date,close},...], SPY: [...] }

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
  set('s-daygain', f.$(dayG),            gc(dayG));
  set('s-daypct',  f.pct(dayPct) + ' vs. yesterday',  gc(dayG));
  set('s-allpct',  f.pct(allPct),        gc(allG));
  set('s-cost',    fxFmt(cost));
  set('s-count',   `${S.positions.length} position${S.positions.length !== 1 ? 's' : ''}`);

  const lu = $('upd-time');
  if (lu) lu.textContent = `Updated ${new Date().toLocaleTimeString()}`;

  buildAllocChart(Port.rows());
  updateLimitsDisplay();
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
      await Promise.all([...syms, 'SPY'].map(async sym => {
        try { hist[sym] = await API.historical(sym); } catch(e) { hist[sym] = []; }
      }));
      _statsHistCache = hist;
    }
    _renderBenchChart();
  } catch(e) {
    if (loadingEl) loadingEl.innerHTML = `<span style="color:var(--muted);font-size:12px">Chart unavailable: ${e.message}</span>`;
  }
}

function _renderBenchChart() {
  const allHist   = _statsHistCache;
  const loadingEl = $('bench-loading');
  if (!allHist) return;

  const from = _statsPeriodFrom(_statsPeriod);

  const spySorted = (allHist['SPY'] || [])
    .filter(d => d.date >= from)
    .sort((a, b) => a.date.localeCompare(b.date));

  if (spySorted.length < 2) {
    if (loadingEl) loadingEl.innerHTML = `<span style="color:var(--muted);font-size:12px">Not enough data for this period.</span>`;
    return;
  }

  const dates = spySorted.map(d => d.date);

  // Portfolio value per date using current share counts
  const portVals = dates.map(date =>
    S.positions.reduce((sum, h) => {
      const entry = (allHist[h.symbol] || []).find(d => d.date === date);
      return sum + (entry ? entry.close * h.shares : 0);
    }, 0)
  );
  const spyVals = spySorted.map(d => d.close);

  // Normalize: % return from first point in period (both start at 0)
  const p0 = portVals[0] || 1, s0 = spyVals[0] || 1;
  const portNorm = portVals.map(v => (v / p0 - 1) * 100);
  const spyNorm  = spyVals.map(v => (v / s0 - 1) * 100);

  // Period return stat cards (use historical closes for consistency with chart)
  const portPeriodPct = portNorm[portNorm.length - 1];
  const spyPeriodPct  = spyNorm[spyNorm.length - 1];
  const portPeriodDol = portVals[portVals.length - 1] - portVals[0];
  const vsSpyDiff     = portPeriodPct - spyPeriodPct;

  const gc = n => n >= 0 ? 'gain' : 'loss';
  const upd = (id, text, cls) => {
    const el = $(id);
    if (!el) return;
    el.textContent = text;
    if (cls) { el.className = el.className.replace(/\bc-(gain|loss|muted)\b/, ''); el.classList.add('c-' + cls); }
  };

  const periodLabel = _statsPeriod === 'YTD' ? 'YTD Return' : `${_statsPeriod} Return`;
  $('stat-period-label') && ($('stat-period-label').textContent = periodLabel);
  upd('stat-period-pct', f.pct(portPeriodPct), gc(portPeriodPct));
  upd('stat-period-dol', f.$(portPeriodDol));
  upd('stat-vs-spy',     (vsSpyDiff >= 0 ? '+' : '') + f.num(vsSpyDiff, 2) + 'pp', gc(vsSpyDiff));
  $('stat-vs-spy-sub') && ($('stat-vs-spy-sub').textContent = `You: ${f.pct(portPeriodPct)} · SPY: ${f.pct(spyPeriodPct)}`);

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
          { label:'Your Portfolio', data:portNorm, borderColor:portPeriodPct>=0?'#14f0a8':'#f0486e', borderWidth:2, pointRadius:0, fill:false, tension:.35 },
          { label:'S&P 500 (SPY)', data:spyNorm,  borderColor:'rgba(90,102,128,.8)', borderWidth:1.5, pointRadius:0, fill:false, tension:.35, borderDash:[4,3] },
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
    S.plan = data.plan || 'free';
  } catch(e) { S.plan = 'free'; }
  updatePlanUI();
}

function updatePlanUI() {
  const badge = $('plan-badge');
  if (badge) {
    badge.textContent = isPremium() ? 'Premium' : 'Free';
    badge.className   = `plan-badge ${isPremium() ? 'premium' : 'free'}`;
  }
  const navBadge = $('nav-plan-badge');
  const navBadgeInner = $('nav-plan-badge-inner');
  if (navBadge && navBadgeInner) {
    navBadge.style.display = '';
    navBadgeInner.textContent = isPremium() ? 'Premium' : 'Free';
    navBadgeInner.className = `plan-badge ${isPremium() ? 'premium' : 'free'}`;
  }
  const actionBtn = $('plan-action-btn');
  if (actionBtn) {
    actionBtn.textContent = isPremium() ? 'Manage Billing' : 'Upgrade to Premium';
    actionBtn.onclick = isPremium() ? openBillingPortal : () => showUpgradeModal('portfolio');
  }
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
    const sym     = r.querySelector('.hs').value.trim().toUpperCase();
    const shares  = parseFloat(r.querySelector('.hq').value);
    const cost    = parseFloat(r.querySelector('.hc').value);
    const target  = parseFloat(r.querySelector('.ht').value);
    const classId = r.querySelector('.hcls')?.value || null;
    if (sym && shares >= 0 && cost >= 0) {
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
      DB.upsertPosition(S.currentFolioId, p.sym, p.shares, p.cost, p.color, p.tw, p.classId)
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
  _statsHistCache = null; // invalidate on every portfolio load
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
      if (btn.dataset.tab === 'calculator') runCalc();
      if (btn.dataset.tab === 'rebalance')  renderRebalance();
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

  $('btn-logout')?.addEventListener('click', async () => {
    await S.db.auth.signOut();
    localStorage.removeItem('dividnd_current_id');
    window.location.href = '/';
  });

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

  if (!S.portfolios.length)
    toast('Welcome to DIVIDND! Create your first portfolio to get started.', 'info');

  // Post-checkout success redirect
  if (new URLSearchParams(location.search).get('upgraded') === '1') {
    toast('Welcome to Premium!', 'info');
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
window.showUpgradeModal = showUpgradeModal;
window.setUpgradeToggle = setUpgradeToggle;
window.handleCheckout   = handleCheckout;
window.showTradeModal   = showTradeModal;
window._setTradeType    = _setTradeType;

init();
