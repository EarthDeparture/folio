# DIVIDND — Feature Roadmap

> Tracking: planned features, grouped by location, with implementation notes.
> Status: 🔵 Planned · 🟡 In Progress · 🟢 Done

---

## Location Map

```
NAV BAR
├── Dashboard Tab        (existing)
├── Dividends Tab        (NEW — dividend-centric hub)
├── Stats Tab            (existing — enhance)
├── Watchlist Tab        (NEW)
├── Calculator Tab       (existing — enhance with What-If)
└── Rebalance Tab        (existing)

OVERLAYS / MODALS
├── Onboarding Flow      (NEW — first-time users only)
└── Price Alert Modal    (NEW — per position / watchlist item)

MOBILE APP             (future — separate repo)
```

---

## 1. Dividends Tab (NEW)

> A dedicated tab for income investors — the core audience of DIVIDND.
> Groups all dividend-related analytics in one place.

### 1a. Income Calendar 🟢
**What:** Monthly calendar view showing expected dividend payouts by date. Each day chip shows tickers paying that day + estimated payout amount (shares × dividend per share).
**Where:** Primary visual on the Dividends tab — above the fold.
**Requires:**
- Dividend ex-date and pay-date data per symbol (from AV `OVERVIEW` or `DIVIDENDS` endpoint — requires premium AV key; fallback to estimated from historical frequency)
- `folio.dividends_cache` table or extend `quotes` table with `next_ex_date`, `next_pay_date`, `annual_dividend` columns
- Calendar UI component (CSS grid, 7 cols, no external dependency)
- Monthly navigation (prev/next month buttons)
- Estimated payout = `position.shares × (annual_dividend / payment_frequency)`

### 1b. Dividend Yield on Cost 🟢
**What:** For each position, show yield-on-cost (YOC) = `annual_dividend_per_share / avg_cost × 100`. Distinct from current yield (which uses market price). Long-term investors care about this more.
**Where:** Holdings table in Dividends tab (separate from main holdings table) + possible column in main dashboard table.
**Requires:**
- `annual_dividend` per symbol (already partially available via `dividend_yield` in quotes cache)
- New column in dividend holdings table: YOC % alongside current yield
- Color coding: YOC above current yield = you bought well (highlight in accent)

### 1c. Annual / Monthly Income Projection 🟢
**What:** Stat cards showing: projected annual income ($), projected monthly income ($), portfolio yield (current), weighted avg YOC. Based on current positions × dividend schedules.
**Where:** Top of Dividends tab (stat cards row, like the main dashboard).
**Requires:**
- Sum of `shares × annual_dividend_per_share` across all positions
- Average weighting by position value

### 1d. Dividend History per Position 🟢
**What:** Already partially exists in the stock modal. Surface this more prominently in the Dividends tab as a table: date | symbol | amount per share | total payout (shares × amt).
**Where:** Bottom section of Dividends tab — sortable list of all past dividend events.
**Requires:**
- AV `DIVIDENDS` endpoint data (premium key) or manual historical entries
- Aggregate view across all positions, sorted by pay date desc

### 1e. DRIP Projection 🟢
**What:** Toggle to simulate dividend reinvestment — show projected portfolio value if all dividends are reinvested vs taken as cash. Tie into the existing Future Value Calculator.
**Where:** Within Dividends tab or as an extension of the Calculator tab.
**Requires:**
- Compound growth model: current value × (1 + (yield/12))^months
- Side-by-side comparison chart (reinvested vs cash)

---

## 2. Stats Tab Enhancements (existing tab)

### 2a. Benchmark Toggle 🟢
**What:** Allow selecting different benchmarks to compare against instead of only SPY. Options: SPY (S&P 500), QQQ (Nasdaq 100), VTI (Total Market), GLD (Gold), BTC-USD (Bitcoin).
**Where:** Small dropdown or pill selector next to the existing benchmark chart period buttons.
**Requires:**
- Replace hardcoded `'SPY'` with `_benchmarkSym` module variable (default: 'SPY')
- Fetch selected benchmark symbol's history alongside portfolio (already in `_statsHistCache`)
- Invalidate cache when benchmark symbol changes
- 5-button pill selector: `SPY | QQQ | VTI | GLD | BTC`

### 2b. Rolling Returns 🟢
**What:** Show rolling 30 / 90 / 365-day returns as a line chart. Visualizes consistency and volatility — not just start-to-end performance. Great complement to the current normalized benchmark chart.
**Where:** New chart card below the benchmark chart in the Stats tab.
**Requires:**
- Same historical data already fetched for benchmark chart — reuse `_statsHistCache`
- For each date: look back N days, compute return over that window
- Chart.js line chart with 3 series (30d, 90d, 365d rolling windows)
- Only show windows where enough data exists (skip first N points)

### 2c. Portfolio Correlation 🟢
**What:** A heatmap showing pairwise correlation between positions using their historical daily returns. Helps identify concentration risk (e.g., AAPL + MSFT + QQQ all moving together).
**Where:** New section in Stats tab below rolling returns.
**Requires:**
- Daily return series per symbol from historical data (already cached)
- Pearson correlation calculation between each pair
- Heatmap: CSS grid of N×N cells, color from --loss (red, -1.0) → white (0) → --gain (green, +1.0)
- Tooltip showing exact correlation value
- Only show when ≥ 2 positions with price history

---

## 3. Watchlist Tab (NEW)

> Track symbols you're interested in but don't own yet. Separate from positions.

### 3a. Watchlist 🔵
**What:** A table of symbols the user is watching — price, daily change, 52w H/L, market cap, P/E. Add/remove symbols easily.
**Where:** New nav tab between Dashboard and Stats, or after Rebalance.
**Requires:**
- `folio.watchlist` table: `id, user_id, symbol, note, added_at` (no folio_id — global per user)
- RLS: `user_id = auth.uid()`
- Quotes fetched same way as positions (AV → Finnhub fallback, same cache)
- Add by typing a ticker; inline remove button
- Optional: short personal note per symbol ("waiting for dip below $150")

### 3b. Price Target / Alert 🟢
**What:** Set a target price per watchlist item or per position. Visual indicator when current price is near or past the target. In-browser toast alert when quote refreshes and crosses target.
**Where:** Extra column in both the Watchlist table and the main Holdings table. Alert fires on `renderDash()` / quote refresh.
**Requires:**
- `target_price` column on `folio.watchlist` (new) and `folio.positions` (new column)
- Alert check: compare `S.quotes[sym].price` vs `target_price` on each quote refresh
- Toast: "AAPL hit your target of $220 ↑" (only fires once per session per symbol — track alerted set in module var)
- Visual: small target icon in table row, colored when near/hit
- Future: email notifications via Supabase Edge Function (phase 2)

---

## 4. Calculator Tab Enhancements (existing tab)

### 4a. What-If Simulator 🟢
**What:** "What if I add $X of [SYMBOL]?" — shows how the new position would change portfolio allocation %, target weight drift, projected annual income, and new total value. Side-by-side before/after.
**Where:** New section in the Calculator tab, below the existing Future Value Calculator. Or a "Simulate" button in the holdings table that pre-fills the symbol.
**Requires:**
- Symbol input + dollar amount input
- Current price lookup from `S.quotes` or API call
- Compute: new shares = amount / price; new allocation = (pos_val + amount) / (port_val + amount)
- Show: allocation change, target weight delta, income change (if dividend data available)
- No DB writes — purely client-side simulation
- Bonus: "Add to Portfolio" button that pre-fills the trade modal with the simulated buy

---

## 5. Onboarding Flow (NEW overlay)

**What:** First-time users (no portfolios yet) see a friendly 3-step guided setup instead of the blank dashboard. Step 1: Name your portfolio. Step 2: Add your first position. Step 3: You're in — here's what you can do. 🟢
**Where:** Fires instead of the empty dashboard state on first login (detect: `S.portfolios.length === 0`).
**Requires:**
- `#ov-onboarding` overlay with step indicator (1/2/3)
- Step 1: portfolio name input → `DB.createPortfolio()`
- Step 2: inline add position form (symbol, shares, avg cost) → `DB.upsertPosition()`
- Step 3: success screen with feature highlights (links to relevant tabs)
- Track completion: `localStorage['dividnd_onboarded'] = '1'` — never show again
- Skip button always visible
- Replaces the current "Create a portfolio to get started" empty state for new users

---

## 6. Mobile App (FUTURE — Separate Repo)

> **Large scope — planned for a dedicated session / new repo.**
> Core concept: a native-feeling mobile app for iOS/Android built with the same Supabase backend.

**Options to evaluate:**
- **React Native + Expo** — fastest path to both iOS + Android, large ecosystem
- **Flutter** — excellent performance, single codebase, strong fintech UI components
- **Capacitor** (wraps the existing Vite app) — lowest effort but feels like a web wrapper

**Shared Infrastructure:**
- Same Supabase backend, same `folio` schema, same RLS policies
- Same Stripe monetization — app store billing OR Stripe web checkout (link from app)
- Same API endpoints (`/api/*`) for quote proxying

**Mobile-Specific Features to Plan:**
- Push notifications for price alerts (requires Expo Push or FCM)
- Biometric auth (Face ID / fingerprint)
- Widget: home screen portfolio value widget
- Offline mode with cached data

**Notes:**
- App Store / Play Store fees and review timelines must be budgeted
- Consider web-first PWA as interim step before native app
- All data-layer logic should be abstracted into a shared JS/TS SDK before starting mobile

---

## Implementation Priority Order

| Priority | Feature | Effort | Impact |
|---|---|---|---|
| 1 | ~~Dividends Tab (income calendar + YOC + projections)~~ 🟢 | Medium | Very High |
| 2 | Watchlist | Low-Medium | High |
| 3 | ~~Benchmark Toggle~~ 🟢 | Low | Medium |
| 4 | ~~Price Target Alerts~~ 🟢 | Low-Medium | High |
| 5 | ~~What-If Simulator~~ 🟢 | Low | Medium |
| 6 | ~~Rolling Returns~~ 🟢 | Low | Medium |
| 7 | ~~Portfolio Correlation~~ 🟢 | Medium | Medium |
| 8 | ~~Onboarding Flow~~ 🟢 | Low | High (retention) |
| 9 | ~~DRIP Projection~~ 🟢 | Medium | Medium |
| — | Mobile App | Very High | Very High (future) |
