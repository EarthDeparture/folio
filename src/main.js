import { Chart, registerables } from 'chart.js';
import { createClient } from '@supabase/supabase-js';

Chart.register(...registerables);

// ═══════════════════════════════════════════════════════════════
// FOLIO · Multi-Portfolio Tracker
// Environment: Vite + .env (VITE_* prefix is required)
// ═══════════════════════════════════════════════════════════════

// ── CONFIGURATION ──────────────────────────────────────────────
const SUPABASE_URL = 'https://qpkvbgeqmrnvhpgqqbmg.supabase.co';
const AV_BASE = 'https://www.alphavantage.co/query';

// Keys come from .env file via Vite (VITE_* prefix is injected by Vite)
const sbKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';
const avKey = import.meta.env.VITE_AV_KEY || '';

const CACHE_Q = 5 * 60 * 1000;    // 5 min
const CACHE_H = 24 * 60 * 60 * 1000;  // 24h

// ── STATE ──────────────────────────────────────────────────────
const S = {
  db: null,
  avKey: '',
  browserId: null,
  portfolios: [],
  currentFolioId: localStorage.getItem('folio_current_id') || null,
  positions: [],
  quotes: {},
  period: '1M',
  sortCol: 'value',
  sortDir: -1,
  drip: true,
  charts: { port: null, alloc: null, calc: null, stock: null },
};

// ── HELPERS ────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const f = {
  $: (n, d = 2) => n == null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: d, maximumFractionDigits: d }).format(n),
  pct: (n, d = 2) => n == null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(d)}%`,
  num: (n, d = 0) => n == null ? '—' : n.toFixed(d),
  compact: n => n == null ? '—' : new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n),
  date: s => new Date(s + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
};

const sign = n => n >= 0 ? 'gain' : 'loss';

// ── BROWSER ID ─────────────────────────────────────────────────
function getBrowserId() {
  if (!S.browserId) {
    S.browserId = localStorage.getItem('folio_browser_id');
    if (!S.browserId) {
      S.browserId = crypto.randomUUID();
      localStorage.setItem('folio_browser_id', S.browserId);
    }
  }
  return S.browserId;
}

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

// ── SUPABASE INIT ──────────────────────────────────────────────
function initDB(key) {
  S.db = createClient(SUPABASE_URL, key, {
    db: { schema: 'folio' }
  });
  return S.db;
}

// ── LOCAL CACHE ─────────────────────────────────────────────────
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
    Object.keys(localStorage).filter(k => k.startsWith('folio_c_q1_') || k.startsWith('folio_c_h_') || k.startsWith('folio_c_div_')).forEach(k => localStorage.removeItem(k));
    toast('Quote cache cleared');
  },
};

// ── DATABASE LAYER ─────────────────────────────────────────────
const DB = {
  async listPortfolios() {
    const { data, error } = await S.db.from('portfolios')
      .select('*')
      .eq('browser_id', getBrowserId())
      .order('created_at', { ascending: true });
    if (error) throw error;
    return data || [];
  },

  async createPortfolio(name) {
    const { data, error } = await S.db.from('portfolios')
      .insert({ browser_id: getBrowserId(), name })
      .select().single();
    if (error) throw error;
    return data;
  },

  async deletePortfolio(id) {
    const { error } = await S.db.from('portfolios').delete().eq('id', id).eq('browser_id', getBrowserId());
    if (error) throw error;
  },

  async listPositions(folioId) {
    const { data, error } = await S.db.from('positions')
      .select('*')
      .eq('folio_id', folioId)
      .order('symbol', { ascending: true });
    if (error) throw error;
    return data || [];
  },

  async upsertPosition(folioId, symbol, shares, avgCost, color) {
    const { data, error } = await S.db.from('positions')
      .upsert(
        { folio_id: folioId, symbol: symbol.toUpperCase(), shares, avg_cost: avgCost, color, updated_at: new Date().toISOString() },
        { onConflict: 'folio_id,symbol' }
      )
      .select().single();
    if (error) throw error;
    return data;
  },

  async deletePosition(folioId, symbol) {
    const { error } = await S.db.from('positions').delete().eq('folio_id', folioId).eq('symbol', symbol);
    if (error) throw error;
  },

  async upsertQuote(q) {
    S.db.from('quotes').upsert({
      symbol: q.symbol, name: q.name || null,
      price: q.price || null, change: q.change || null,
      changes_percentage: q.changesPercentage || null,
      market_cap: q.marketCap || null, pe: q.pe || null,
      year_high: q.yearHigh || null, year_low: q.yearLow || null,
      dividend_yield: q.dividendYield || null,
      cached_at: new Date().toISOString(),
    }, { onConflict: 'symbol' }).then(({ error }) => {
      if (error) console.warn('[FOLIO] Quote cache write failed:', error.message);
    });
  },

  async getCachedQuote(symbol) {
    const { data } = await S.db.from('quotes').select('*').eq('symbol', symbol).single();
    return data;
  },
};

// ── ALPHA VANTAGE API ──────────────────────────────────────────
const API = {
  async _fetch(url) {
    const key = S.avKey.trim();
    const fullUrl = `${url}&apikey=${encodeURIComponent(key)}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const r = await fetch(fullUrl, { signal: ctrl.signal });
      clearTimeout(timer);
      const text = await r.text();
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = JSON.parse(text);
      if (data['Error Message']) throw new Error(data['Error Message']);
      if (data['Note']) throw new Error('API rate limit: ' + data['Note']);
      return data;
    } catch(e) {
      clearTimeout(timer);
      if (e.name === 'AbortError') throw new Error('Request timed out');
      throw e;
    }
  },

  async _oneQuote(symbol) {
    const cKey = 'q1_' + symbol;
    const cached = Cache.get(cKey);
    if (cached) return cached;

    const d = await this._fetch(`${AV_BASE}?function=GLOBAL_QUOTE&symbol=${symbol}`);
    const raw = d?.['Global Quote'];
    if (!raw?.['01. symbol']) return null;

    const q = {
      symbol: raw['01. symbol'],
      name: symbol,
      price: parseFloat(raw['05. price']),
      change: parseFloat(raw['09. change']) || 0,
      changesPercentage: parseFloat(raw['10. change percent']) || 0,
      marketCap: raw['06. market cap'] || null,
      pe: raw['07. pe ratio'] || null,
      yearHigh: parseFloat(raw['03. high']) || null,
      yearLow: parseFloat(raw['04. low']) || null,
      dividendYield: parseFloat(raw['08. dividend yield']) || 0,
    };

    Cache.set(cKey, q, CACHE_Q);
    DB.upsertQuote(q);
    return q;
  },

  async quotes(symbols) {
    const results = [];
    for (let i = 0; i < symbols.length; i += 5) {
      const chunk = symbols.slice(i, i + 5);
      const batch = await Promise.all(
        chunk.map(sym => this._oneQuote(sym).catch(e => {
          console.error(`[FOLIO] Quote failed ${sym}:`, e.message);
          return null;
        }))
      );
      results.push(...batch.filter(Boolean));
      if (i + 5 < symbols.length) await sleep(12000);
    }
    return results;
  },

  async historical(symbol, from) {
    const cKey = `h_${symbol}_${from}`;
    const cached = Cache.get(cKey);
    if (cached) return cached;

    const d = await this._fetch(`${AV_BASE}?function=TIME_SERIES_DAILY&symbol=${symbol}&outputsize=full`);
    const ts = d?.['Time Series (Daily)'];
    if (!ts) return [];

    const prices = Object.keys(ts).sort().reverse()
      .filter(date => date >= from)
      .map(date => ({ date, close: parseFloat(ts[date]['4. close']) }));

    if (prices.length) Cache.set(cKey, prices, CACHE_H);
    return prices;
  },

  async dividends(symbol) {
    const cKey = `div_${symbol}`;
    const cached = Cache.get(cKey);
    if (cached) return cached;

    const d = await this._fetch(`${AV_BASE}?function=DIVIDENDS&symbol=${symbol}`);
    const data = d?.data;
    if (!Array.isArray(data)) return [];

    const divs = data.map(div => ({
      date: div.ex_dividend_date,
      label: div.dividend_type || 'Dividend',
      dividend: parseFloat(div.amount),
    }));
    if (divs.length) Cache.set(cKey, divs, CACHE_H);
    return divs;
  },

  async test() {
    try {
      const d = await this._oneQuote('AAPL');
      return { ok: !!d?.symbol, data: d };
    } catch(e) {
      return { ok: false, error: e.message };
    }
  },
};

// ── PORTFOLIO MATH ─────────────────────────────────────────────
const Port = {
  value() { return S.positions.reduce((s, h) => s + (S.quotes[h.symbol] || 0) * h.shares, 0); },
  cost() { return S.positions.reduce((s, h) => s + h.avg_cost * h.shares, 0); },
  dayGain() { return S.positions.reduce((s, h) => s + (S.quotes[h.symbol] || 0) * h.shares, 0); },

  rows() {
    return S.positions.map((h, i) => {
      const q = S.quotes[h.symbol];
      const px = q?.price ?? null;
      const val = px != null ? px * h.shares : null;
      const cost = h.avg_cost * h.shares;
      const ret = val != null && cost > 0 ? ((val - cost) / cost) * 100 : null;
      const day = q?.changesPercentage ?? null;
      const div = q?.dividendYield ? q.dividendYield * 100 : 0;
      return { ...h, avgCost: h.avg_cost, px, val, cost, ret, day, div, name: q?.name || h.symbol, color: h.color || COLORS[i % COLORS.length] };
    });
  },
};

// ── CHART HELPERS ───────────────────────────────────────────────
Chart.defaults.color = '#5a6680';
Chart.defaults.borderColor = 'rgba(255,255,255,0.06)';
Chart.defaults.font.family = "'JetBrains Mono',monospace";

function lineGrad(ctx, isGain) {
  const g = ctx.chart.ctx.createLinearGradient(0, 0, 0, 240);
  g.addColorStop(0, isGain ? 'rgba(20,240,168,.15)' : 'rgba(240,72,110,.15)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  return g;
}

const TT_BASE = { backgroundColor: '#0c1120', borderColor: 'rgba(255,255,255,0.1)', borderWidth: 1, padding: 10 };

function buildPortChart(labels, vals) {
  if (S.charts.port) S.charts.port.destroy();
  const isGain = !vals.length || vals[vals.length - 1] >= vals[0];
  const col = isGain ? '#14f0a8' : '#f0486e';
  S.charts.port = new Chart($('c-portfolio'), {
    type: 'line',
    data: { labels, datasets: [{ data: vals, borderColor: col, borderWidth: 1.5, pointRadius: 0, fill: true, backgroundColor: ctx => lineGrad(ctx, isGain), tension: .35 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: false }, tooltip: { ...TT_BASE, callbacks: { label: c => ` ${f.$(c.parsed.y)}` } } },
      scales: {
        x: { grid: { display: false }, ticks: { maxTicksLimit: 6, font: { size: 10 } } },
        y: { position: 'right', grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { font: { size: 10 }, callback: v => f.$(v, 0) } },
      },
    },
  });
}

function buildAllocChart(rows) {
  if (S.charts.alloc) S.charts.alloc.destroy();
  const data = [...rows].sort((a, b) => (b.val || 0) - (a.val || 0));
  S.charts.alloc = new Chart($('c-alloc'), {
    type: 'doughnut',
    data: { labels: data.map(d => d.symbol), datasets: [{ data: data.map(d => d.val || 0), backgroundColor: data.map(d => d.color), borderColor: '#060a14', borderWidth: 2, hoverOffset: 4 }] },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '65%',
      plugins: {
        legend: { position: 'bottom', labels: { padding: 10, boxWidth: 9, boxHeight: 9, font: { size: 10 }, color: '#5a6680' } },
        tooltip: { ...TT_BASE, callbacks: { label: c => {
          const total = c.dataset.data.reduce((a, b) => a + b, 0);
          return ` ${c.label}: ${f.$(c.raw)} (${f.num(c.raw / total * 100, 1)}%)`;
        } } },
      },
    },
  });
}

function buildCalcChart(labels, contrib, portfolio, divs) {
  if (S.charts.calc) S.charts.calc.destroy();
  S.charts.calc = new Chart($('c-calc'), {
    type: 'line',
    data: { labels, datasets: [
      { label: 'Portfolio', data: portfolio, borderColor: '#14f0a8', borderWidth: 2, pointRadius: 0, fill: true, backgroundColor: 'rgba(20,240,168,.07)', tension: .4 },
      { label: 'Contributed', data: contrib, borderColor: '#5b8af0', borderWidth: 1.5, pointRadius: 0, fill: false, borderDash: [4, 4], tension: .4 },
      { label: 'Dividends', data: divs, borderColor: '#f0c05b', borderWidth: 1.5, pointRadius: 0, fill: false, tension: .4 },
    ] },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'bottom', labels: { padding: 14, boxWidth: 9, boxHeight: 9, font: { size: 10 } } },
        tooltip: { ...TT_BASE, callbacks: { label: c => ` ${c.dataset.label}: ${f.$(c.parsed.y, 0)}` } },
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 10 } } },
        y: { position: 'right', grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { font: { size: 10 }, callback: v => f.compact(v) } },
      },
    },
  });
}

// ── FOLIO PILL ─────────────────────────────────────────────────
function updateFolioPill() {
  const folio = S.portfolios.find(p => p.id === S.currentFolioId);
  $('fp-name').textContent = folio ? folio.name : 'No portfolio';
}

// ── RENDER DASHBOARD ───────────────────────────────────────────
function renderDash() {
  const hasPortfolio = !!S.currentFolioId && S.positions.length > 0;
  $('dash-empty').style.display = !S.currentFolioId ? 'flex' : 'none';
  $('dash-content').style.display = S.currentFolioId ? 'block' : 'none';

  if (!S.currentFolioId) return;

  const val = Port.value();
  const cost = Port.cost();
  const dayG = Port.dayGain();
  const allG = val - dayG;
  const dayPct = (val - dayG) > 0 ? dayG / (val - dayG) * 100 : 0;
  const allPct = cost > 0 ? allG / cost * 100 : 0;
  const gc = g => g >= 0 ? 'var(--gain)' : 'var(--loss)';

  const set = (id, txt, col) => { const el = $(id); if (!el) return; el.textContent = txt; if (col) el.style.color = col; };
  set('s-total', f.$(val), gc(allG));
  set('s-allgain', `${f.$(allG)} (${f.pct(allPct)})`, gc(allG));
  set('s-daygain', f.$(dayG), gc(dayG));
  set('s-daypct', f.pct(dayPct) + ' vs. yesterday', gc(dayG));
  set('s-allpct', f.pct(allPct), gc(allG));
  set('s-cost', f.$(cost));
  set('s-count', `${S.positions.length} position${S.positions.length !== 1 ? 's' : ''}`);

  const lu = $('upd-time');
  if (lu) lu.textContent = `Updated ${new Date().toLocaleTimeString()}`;

  buildAllocChart(Port.rows());
}

// ── RENDER HOLDINGS ─────────────────────────────────────────────
function renderHoldings() {
  const tbody = $('holdings-body');
  if (!tbody) return;

  let rows = Port.rows();
  rows.sort((a, b) => {
    const va = a[S.sortCol] ?? 0, vb = b[S.sortCol] ?? 0;
    return typeof va === 'string' ? va.localeCompare(vb) * S.sortDir : (va - vb) * S.sortDir;
  });

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:40px;color:var(--muted)">No positions yet. Add them in Settings (⚙).</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(h => `
    <tr data-sym="${h.symbol}">
      <td>
        <div class="sym-cell">
          <div class="sym-badge" style="background:${h.color}1a;border:1px solid ${h.color}33;color:${h.color}">${h.symbol.slice(0,4)}</div>
          <div class="sym-info">
            <div class="sym">${h.symbol}</div>
            <div class="name">${h.name}</div>
          </div>
        </div>
      </td>
      <td class="mono col-shares">${f.num(h.shares, h.shares % 1 === 0 ? 0 : 4)}</td>
      <td class="mono col-avgcost" style="text-align:right">${f.$(h.avg_cost)}</td>
      <td class="mono" style="text-align:right">${f.$(h.px)}</td>
      <td class="mono" style="text-align:right">${f.$(h.val)}</td>
      <td style="text-align:right">
        <span class="badge ${h.day != null ? sign(h.day) : 'neu'}">${h.day != null ? f.pct(h.day) : '—'}</span>
      </td>
      <td style="text-align:right">
        <div class="mono ${h.ret != null ? 'c-' + sign(h.ret) : 'c-muted'}">${h.ret != null ? f.pct(h.ret) : '—'}</div>
        <div class="mono" style="font-size:10px;color:var(--muted)">${f.$(h.val != null ? h.val - h.cost : null)}</div>
      </td>
      <td class="mono col-divyield" style="text-align:right;color:${h.div > 0 ? 'var(--gain)' : 'var(--muted)'}">
        ${h.div > 0 ? f.pct(h.div) : '—'}
      </td>
    </tr>
  `).join('');

  tbody.querySelectorAll('tr[data-sym]').forEach(row =>
    row.addEventListener('click', () => openStock(row.dataset.sym))
  );
}

// ── PORTFOLIO CHART ─────────────────────────────────────────────
async function loadPortChart(period) {
  if (!S.positions.length) return;
  const days = { '1M': 30, '3M': 90, '6M': 182, '1Y': 365 }[period] || 30;
  const from = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
  const syms = S.positions.map(h => h.symbol);
  const allHist = {};

  for (const sym of syms) {
    try { allHist[sym] = await API.historical(sym, from); }
    catch(e) { console.warn('Port chart skip:', sym, e.message); allHist[sym] = []; }
  }

  const sample = Object.values(allHist).find(a => a.length) || [];
  const dates = sample.map(d => d.date);

  if (dates.length < 2) {
    buildPortChart(['Start', 'Now'], [Port.cost(), Port.value()]);
    return;
  }

  const vals = dates.map(date => S.positions.reduce((sum, h) => {
    const e = (allHist[h.symbol] || []).find(d => d.date === date);
    return sum + (e ? e.close * h.shares : 0);
  }, 0));
  const labels = dates.map(d => new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));

  buildPortChart(labels, vals);
}

// ── STOCK MODAL ─────────────────────────────────────────────────
async function openStock(symbol) {
  $('stk-modal-title').textContent = symbol;
  $('stk-modal-body').innerHTML = '<div class="spinner-wrap"><div class="spinner"></div>Loading…</div>';
  $('ov-stock').classList.add('open');

  const q = S.quotes[symbol];
  const h = S.positions.find(p => p.symbol === symbol);
  const px = q?.price ?? 0;
  const chg = q?.changesPercentage ?? 0;
  const val = px * (h?.shares ?? 0);
  const cost = (h?.avg_cost ?? 0) * (h?.shares ?? 0);
  const idx = S.positions.findIndex(p => p.symbol === symbol);
  const color = h?.color || COLORS[idx % COLORS.length];

  $('stk-modal-body').innerHTML = `
    <div class="stk-hdr">
      <div class="stk-icon" style="background:${color}1a;border:1px solid ${color}33;color:${color}">${symbol.slice(0,4)}</div>
      <div class="stk-name"><h2>${symbol}</h2><p>${q?.name ?? ''}</p></div>
      <div class="stk-price">
        <div class="price">${f.$(px)}</div>
        <span class="badge ${sign(chg)}" style="float:right;margin-top:5px">${f.pct(chg)}</span>
      </div>
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
  `;

  try {
    const from = new Date(Date.now() - 365 * 86400000).toISOString().split('T')[0];
    const hist = await API.historical(symbol, from);
    const loading = $('stk-loading');
    if (loading) loading.remove();
    if (hist.length) {
      const sliced = hist.slice(0, 252).reverse();
      const labels = sliced.map(d => new Date(d.date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
      const prices = sliced.map(d => d.close);
      if (S.charts.stock) S.charts.stock.destroy();
      const isGain = prices[prices.length - 1] >= prices[0];
      S.charts.stock = new Chart($('stk-chart'), {
        type: 'line',
        data: { labels, datasets: [{ data: prices, borderColor: isGain ? '#14f0a8' : '#f0486e', borderWidth: 1.5, pointRadius: 0, fill: true, backgroundColor: ctx => lineGrad(ctx, isGain), tension: .35 }] },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false }, tooltip: { ...TT_BASE, callbacks: { label: c => ` ${f.$(c.parsed.y)}` } } },
          scales: {
            x: { grid: { display: false }, ticks: { maxTicksLimit: 5, font: { size: 9 } } },
            y: { position: 'right', grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { font: { size: 9 }, callback: v => f.$(v, 0) } },
          },
        },
      });
    }
  } catch(e) {
    const el = $('stk-loading');
    if (el) el.innerHTML = `<span style="color:var(--muted);font-size:12px">Chart unavailable: ${e.message}</span>`;
  }

  try {
    const divs = await API.dividends(symbol);
    const el = $('stk-divs');
    if (!el) return;
    el.innerHTML = divs.length
      ? `<div class="div-list">${divs.slice(0, 8).map(d => `<div class="div-row"><span class="dr">${f.date(d.date)}</span><span>${d.label || 'Cash Dividend'}</span><span class="da">${f.$(d.dividend)}/share</span></div>`).join('')}</div>`
      : `<p style="color:var(--muted);font-size:12px;text-align:center;padding:14px">No dividend history available</p>`;
  } catch(e) {
    const el = $('stk-divs');
    if (el) el.innerHTML = `<p style="color:var(--muted);font-size:12px;text-align:center;padding:14px">${e.message.includes('limit') ? 'API rate limit reached' : `Could not load dividends: ${e.message}`}</p>`;
  }
}

// ── CALCULATOR ──────────────────────────────────────────────────
function runCalc() {
  const start = parseFloat($('c-start').value) || 0;
  const monthly = parseFloat($('c-monthly').value) || 0;
  const annRet = parseFloat($('c-return').value) || 0;
  const annDiv = parseFloat($('c-div').value) || 0;
  const years = parseInt($('c-years').value) || 20;
  const mRet = annRet / 100 / 12;
  const mDiv = annDiv / 100 / 12;
  const months = years * 12;

  let port = start, contrib = start, divTotal = 0;
  const labels = [], portVals = [], contribVals = [], divVals = [];

  for (let m = 0; m <= months; m++) {
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
  $('r-final').textContent = f.$(final, 0);
  $('r-contrib').textContent = f.$(contrib, 0);
  $('r-returns').textContent = f.$(final - contrib, 0);
  $('r-divs').textContent = f.$(divTotal, 0);
  buildCalcChart(labels, contribVals, portVals, divVals);
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
      list.innerHTML = '<p style="color:var(--muted);font-size:13px;text-align:center;padding:20px">No portfolios yet.</p>';
      return;
    }
    list.innerHTML = S.portfolios.map(p => `
      <div class="folio-item ${p.id === S.currentFolioId ? 'active' : ''}" data-id="${p.id}">
        <div>
          <div class="fi-name">${p.name}</div>
          <div class="fi-meta">Created ${new Date(p.created_at).toLocaleDateString()}</div>
        </div>
        <div class="folio-actions" onclick="event.stopPropagation()">
          ${p.id !== S.currentFolioId ? `<button class="btn btn-sm" onclick="selectFolio('${p.id}')">Select</button>` : '<span style="font-size:11px;color:var(--accent);font-weight:600">Active</span>'}
          <button class="btn btn-sm btn-danger" onclick="deleteFolioPrompt('${p.id}','${p.name}')">Delete</button>
        </div>
      </div>
    `).join('');
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

async function deleteFolioPrompt(id, name) {
  if (!confirm(`Delete portfolio "${name}" and all its positions? This cannot be undone.`)) return;
  try {
    await DB.deletePortfolio(id);
    if (S.currentFolioId === id) {
      S.currentFolioId = null;
      S.positions = [];
      localStorage.removeItem('folio_current_id');
      updateFolioPill();
      renderDash();
      renderHoldings();
    }
    toast('Portfolio deleted');
    await renderFolioList();
  } catch(e) {
    toast('Delete failed: ' + e.message, 'error');
  }
}

async function createFolio() {
  const name = prompt('Portfolio name:');
  if (!name?.trim()) return;
  try {
    const folio = await DB.createPortfolio(name.trim());
    S.portfolios.push(folio);
    S.currentFolioId = folio.id;
    S.positions = [];
    localStorage.setItem('folio_current_id', folio.id);
    closeOverlay('ov-folio');
    updateFolioPill();
    renderDash();
    renderHoldings();
    toast(`Created: ${folio.name}`);
  } catch(e) {
    toast('Create failed: ' + e.message, 'error');
  }
}

// ── SETTINGS ────────────────────────────────────────────────────
function openSettings() {
  $('set-avkey').value = S.avKey;
  const folio = S.portfolios.find(p => p.id === S.currentFolioId);
  $('settings-folio-name').textContent = folio ? `— ${folio.name}` : '';
  renderEditor();
  $('ov-settings').classList.add('open');
}

function renderEditor() {
  const ed = $('h-editor');
  if (!ed) return;
  ed.innerHTML = S.positions.map((h, i) => `
    <div class="h-row" data-i="${i}">
      <input type="text" class="hs" placeholder="AAPL" value="${h.symbol}" style="text-transform:uppercase">
      <input type="number" class="hq" placeholder="Shares" value="${h.shares}" min="0" step="any">
      <input type="number" class="hc" placeholder="Avg $" value="${h.avg_cost}" min="0" step="any">
      <button class="rm-btn" data-sym="${h.symbol}">×</button>
    </div>`).join('');

  ed.querySelectorAll('.rm-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const sym = btn.dataset.sym;
      if (!sym) { btn.closest('.h-row').remove(); return; }
      try {
        await DB.deletePosition(S.currentFolioId, sym);
        S.positions = S.positions.filter(p => p.symbol !== sym);
        renderEditor();
        loadAll();
        toast(`Removed ${sym}`);
      } catch(e) { toast('Delete failed: ' + e.message, 'error'); }
    });
  });
}

async function saveSettings() {
  const avKey = $('set-avkey').value.trim().replace(/\s/g, '');
  if (avKey) { S.avKey = avKey; localStorage.setItem('folio_av_key', avKey); }

  if (!S.currentFolioId) { closeOverlay('ov-settings'); return; }

  const rows = document.querySelectorAll('#h-editor .h-row');
  const saves = [];
  rows.forEach((r, i) => {
    const sym = r.querySelector('.hs').value.trim().toUpperCase();
    const shares = parseFloat(r.querySelector('.hq').value);
    const cost = parseFloat(r.querySelector('.hc').value);
    if (sym && shares > 0 && cost >= 0) {
      const existing = S.positions.find(p => p.symbol === sym);
      saves.push(DB.upsertPosition(S.currentFolioId, sym, shares, cost, existing?.color || COLORS[i % COLORS.length]));
    }
  });

  try {
    await Promise.all(saves);
    S.positions = await DB.listPositions(S.currentFolioId);
    closeOverlay('ov-settings');
    toast('Positions saved');
    loadAll();
  } catch(e) {
    toast('Save failed: ' + e.message, 'error');
  }
}

// ── EXPORT / IMPORT ─────────────────────────────────────────────
function exportJSON() {
  const folio = S.portfolios.find(p => p.id === S.currentFolioId);
  const blob = new Blob([JSON.stringify({ folio: folio?.name || 'Unknown', positions: S.positions, exportedAt: new Date().toISOString() }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `folio-${(folio?.name || 'export').replace(/\s/g, '-')}-${new Date().toISOString().split('T')[0]}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('Exported');
}

async function importJSON(file) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!Array.isArray(data.positions)) throw new Error('Invalid file format');
    if (!confirm(`Import ${data.positions.length} positions into a new portfolio "${data.folio || 'Imported'}"?`)) return;

    const folio = await DB.createPortfolio(data.folio || 'Imported');
    for (const p of data.positions) {
      await DB.upsertPosition(folio.id, p.symbol, p.shares, p.avg_cost ?? p.avgCost ?? 0, p.color);
    }
    S.portfolios.push(folio);
    S.currentFolioId = folio.id;
    localStorage.setItem('folio_current_id', folio.id);
    updateFolioPill();
    await loadAll();
    toast('Import complete: ' + folio.name);
  } catch(e) {
    toast('Import failed: ' + e.message, 'error');
  }
}

// ── OVERLAY HELPERS ─────────────────────────────────────────────
function closeOverlay(id) {
  const ov = $(id);
  if (!ov) return;
  ov.classList.remove('open');
  if (id === 'ov-stock' && S.charts.stock) { S.charts.stock.destroy(); S.charts.stock = null; }
}

// ── LOAD ALL ─────────────────────────────────────────────────────
async function loadAll() {
  if (!S.currentFolioId) { renderDash(); renderHoldings(); return; }

  try {
    S.positions = await DB.listPositions(S.currentFolioId);
  } catch(e) {
    console.error('Failed to load positions:', e);
    toast('Could not load positions: ' + e.message, 'error');
    return;
  }

  renderDash();
  renderHoldings();

  const syms = S.positions.map(h => h.symbol);
  if (!syms.length) return;

  const tbody = $('holdings-body');
  if (tbody) tbody.innerHTML = `<tr><td colspan="8"><div class="spinner-wrap"><div class="spinner">Fetching quotes…</div></div></td></tr>`;

  try {
    const qs = await API.quotes(syms);
    qs.forEach(q => { S.quotes[q.symbol] = q; });
    renderDash();
    renderHoldings();

    const total = Port.value();
    if (total > 0) $('c-start').value = Math.round(total);
    runCalc();

    loadPortChart(S.period).catch(e => console.warn('Port chart:', e.message));
  } catch(e) {
    console.error('Quotes failed:', e);
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

// ── EVENTS ──────────────────────────────────────────────────────
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
  $('btn-refresh')?.addEventListener('click', () => { Cache.clearQuotes(); loadAll(); toast('Refreshing quotes…', 'info'); });
  $('btn-settings')?.addEventListener('click', openSettings);
  $('btn-add-pos')?.addEventListener('click', openSettings);
  $('dash-create-btn')?.addEventListener('click', () => { openFolioModal(); });

  $('btn-create-folio')?.addEventListener('click', createFolio);

  $('save-settings')?.addEventListener('click', saveSettings);
  $('add-holding')?.addEventListener('click', () => {
    S.positions.push({ symbol: '', shares: 0, avg_cost: 0, folio_id: S.currentFolioId, color: null });
    renderEditor();
  });

  $('btn-export')?.addEventListener('click', exportJSON);
  $('btn-import')?.addEventListener('click', () => $('import-file').click());
  $('import-file')?.addEventListener('change', e => { if (e.target.files[0]) importJSON(e.target.files[0]); });
  $('btn-clear-cache')?.addEventListener('click', Cache.clearQuotes);

  $('btn-calc')?.addEventListener('click', runCalc);
  ['c-start', 'c-monthly', 'c-return', 'c-div', 'c-years'].forEach(id => $(id)?.addEventListener('input', runCalc));
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

// ── COLORS CONSTANT ─────────────────────────────────────────────
const COLORS = [
  '#14f0a8', '#5b8af0', '#f05b8a', '#f0c05b', '#a05bf0',
  '#5be8f0', '#f0905b', '#8af05b', '#c05bf0', '#f05b5b',
  '#5bd4f0', '#f0d65b', '#5bf0c0', '#e05bf0', '#90f05b',
  '#5b90f0', '#f0a05b', '#5bf080', '#f07a5b', '#a0c05b',
];

// ── BOOTSTRAP ───────────────────────────────────────────────────
async function bootstrapApp() {
  getBrowserId();

  try {
    S.portfolios = await DB.listPortfolios();
  } catch(e) {
    toast('Could not connect to Supabase: ' + e.message, 'error');
    console.error(e);
  }

  updateFolioPill();

  if (S.currentFolioId && !S.portfolios.find(p => p.id === S.currentFolioId)) {
    S.currentFolioId = null;
    localStorage.removeItem('folio_current_id');
    updateFolioPill();
  }

  runCalc();
  await loadAll();

  if (!S.portfolios.length) {
    toast('No portfolios yet — create one to get started.', 'info');
  }
}

// ── INIT ─────────────────────────────────────────────────────────
function init() {
  initEvents();

  if (!sbKey) {
    console.error('[FOLIO] No VITE_SUPABASE_ANON_KEY found. Create .env file and set VITE_SUPABASE_ANON_KEY (VITE_* prefix is required by Vite).');
    $('setup-screen').style.display = 'flex';
    $('app-shell').style.display = 'none';
    return;
  }

  S.avKey = avKey || localStorage.getItem('folio_av_key') || '';
  if (avKey) localStorage.setItem('folio_av_key', avKey);

  initDB(sbKey);
  $('setup-screen').style.display = 'none';
  $('app-shell').style.display = 'block';

  bootstrapApp();
}

init();
