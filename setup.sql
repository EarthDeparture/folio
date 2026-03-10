-- ═══════════════════════════════════════════════════════════════
-- FOLIO SCHEMA SETUP
-- Supabase Hub Project: earthdeparture-hub (qpkvbgeqmrnvhpgqqbmg)
-- Run this in: Supabase SQL Editor
-- After running: Dashboard → Settings → API → Extra search path → add: folio
-- ═══════════════════════════════════════════════════════════════

-- Enable folio schema
create schema if not exists folio;

-- ── PORTFOLIOS TABLE ──────────────────────────────────────────
-- browser_id stored directly on portfolios (no separate users table)
-- Keeps queries simple; auth layer can be added later
create table if not exists folio.portfolios (
  id         uuid primary key default gen_random_uuid(),
  browser_id text not null,
  name       text not null check (char_length(name) between 1 and 50),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ── POSITIONS TABLE ───────────────────────────────────────────
-- Holdings within a portfolio (folio_id FK, symbol unique per folio)
create table if not exists folio.positions (
  id         uuid primary key default gen_random_uuid(),
  folio_id   uuid not null references folio.portfolios(id) on delete cascade,
  symbol     text not null check (char_length(symbol) between 1 and 10),
  shares     numeric not null check (shares > 0),
  avg_cost   numeric not null check (avg_cost >= 0),
  color      text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(folio_id, symbol)
);

-- ── QUOTES TABLE ──────────────────────────────────────────────
-- Cached Alpha Vantage quotes — shared across all users
-- Enables future users to hit the cache instead of AV API
create table if not exists folio.quotes (
  symbol              text primary key,
  name                text,
  price               numeric,
  change              numeric,
  changes_percentage  numeric,
  market_cap          text,
  pe                  numeric,
  year_high           numeric,
  year_low            numeric,
  dividend_yield      numeric,
  cached_at           timestamptz default now()
);

-- ── INDEXES ───────────────────────────────────────────────────
create index if not exists folio_portfolios_browser_id_idx on folio.portfolios(browser_id);
create index if not exists folio_positions_folio_id_idx    on folio.positions(folio_id);
create index if not exists folio_quotes_cached_at_idx      on folio.quotes(cached_at desc);

-- ── ROW LEVEL SECURITY ────────────────────────────────────────
-- Permissive for now (single-user app, browser_id isolation is app-level).
-- Tighten these policies when auth is added.
alter table folio.portfolios enable row level security;
alter table folio.positions  enable row level security;
alter table folio.quotes     enable row level security;

create policy "Allow all on portfolios"
  on folio.portfolios for all using (true) with check (true);

create policy "Allow all on positions"
  on folio.positions for all using (true) with check (true);

create policy "Allow all on quotes"
  on folio.quotes for all using (true) with check (true);

-- ═══════════════════════════════════════════════════════════════
-- POST-SETUP CHECKLIST
-- 1. Run this SQL in Supabase SQL Editor
-- 2. Dashboard → Settings → API → Extra search path → add: folio
-- 3. Open folio/index.html and enter:
--    - Your Supabase anon key (shown on first-run prompt)
--    - Your Alpha Vantage API key
-- ═══════════════════════════════════════════════════════════════
