-- ═══════════════════════════════════════════════════════════════
-- FOLIO SCHEMA SETUP
-- Supabase Hub Project: earthdeparture-hub (qpkvbgeqmrnvhpgqqbmg)
-- Run this in: Supabase SQL Editor
-- ═══════════════════════════════════════════════════════════════

-- Enable folio schema
create schema if not exists folio;

-- ── PORTFOLIOS TABLE ──────────────────────────────────────────
create table if not exists folio.portfolios (
  id         uuid primary key default gen_random_uuid(),
  browser_id text not null,
  name       text not null check (char_length(name) between 1 and 50),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ── POSITIONS TABLE ───────────────────────────────────────────
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
alter table folio.portfolios enable row level security;
alter table folio.positions  enable row level security;
alter table folio.quotes     enable row level security;

-- Portfolios: Allow all operations for now (browser_id isolation at app level)
create policy "Allow all on portfolios"
  on folio.portfolios for all
  using (true)
  with check (true);

-- Positions: Allow all operations for now (browser_id isolation at app level)
create policy "Allow all on positions"
  on folio.positions for all
  using (true)
  with check (true);

-- Quotes: Allow read-only access for all (public cache)
create policy "Allow select on quotes"
  on folio.quotes for select
  using (true);

-- ═══════════════════════════════════════════════════════════════
-- SETUP COMPLETE
-- ═══════════════════════════════════════════════════════════════
-- Dashboard → Settings → API → Extra search path → add: folio
-- ═══════════════════════════════════════════════════════════════
