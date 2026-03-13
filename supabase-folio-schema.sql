-- =============================================================================
-- FOLIO SCHEMA - Full setup for new Supabase project
-- Run this entire script in: Supabase Dashboard -> SQL Editor -> New query
-- After running: Settings -> API -> "Extra search path" -> add: folio
-- =============================================================================

-- Schema
create schema if not exists folio;

-- -----------------------------------------------------------------------------
-- Tables
-- -----------------------------------------------------------------------------

create table folio.portfolios (
  id         uuid        primary key default gen_random_uuid(),
  owner      uuid        not null,
  name       text        not null check (char_length(name) between 1 and 50),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table folio.positions (
  id         uuid    primary key default gen_random_uuid(),
  folio_id   uuid    not null references folio.portfolios(id) on delete cascade,
  symbol     text    not null check (char_length(symbol) between 1 and 10),
  shares     numeric not null check (shares >= 0),
  avg_cost   numeric not null check (avg_cost >= 0),
  color      text,
  target_weight numeric not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(folio_id, symbol)
);

create table folio.quotes (
  symbol             text primary key,
  name                text,
  price               numeric,
  change              numeric,
  changes_percentage   numeric,
  market_cap          text,
  pe                  numeric,
  year_high           numeric,
  year_low            numeric,
  dividend_yield      numeric,
  cached_at           timestamptz default now()
);

-- -----------------------------------------------------------------------------
-- Indexes
-- -----------------------------------------------------------------------------
create index idx_folio_portfolios_owner on folio.portfolios(owner);
create index idx_folio_positions_folio_id on folio.positions(folio_id);
create index idx_folio_quotes_cached_at on folio.quotes(cached_at desc);

-- -----------------------------------------------------------------------------
-- Helper: is portfolio owned by the authenticated user (for RLS on positions)
-- -----------------------------------------------------------------------------
create or replace function folio.is_portfolio_owned_by_current_user(p_folio_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, folio, auth
as $$
  select exists (
    select 1 from folio.portfolios
    where id = p_folio_id and owner = auth.uid()
  );
$$;

-- -----------------------------------------------------------------------------
-- Trigger: set portfolio owner on insert (auth.uid(); no client spoofing)
-- -----------------------------------------------------------------------------
create or replace function folio.set_portfolio_owner()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  new.owner := coalesce(new.owner, auth.uid());
  return new;
end;
$$;

drop trigger if exists trg_set_portfolio_owner on folio.portfolios;
create trigger trg_set_portfolio_owner
  before insert on folio.portfolios
  for each row
  execute function folio.set_portfolio_owner();

-- -----------------------------------------------------------------------------
-- Row Level Security
-- -----------------------------------------------------------------------------
alter table folio.portfolios enable row level security;
alter table folio.positions  enable row level security;
alter table folio.quotes     enable row level security;

-- Portfolios: authenticated users see/change only their own
create policy "portfolios_select"
  on folio.portfolios for select to authenticated
  using (owner = auth.uid());

create policy "portfolios_insert"
  on folio.portfolios for insert to authenticated
  with check (true);

create policy "portfolios_update"
  on folio.portfolios for update to authenticated
  using (owner = auth.uid())
  with check (owner = auth.uid());

create policy "portfolios_delete"
  on folio.portfolios for delete to authenticated
  using (owner = auth.uid());

-- Positions: only for portfolios owned by the current user
create policy "positions_select"
  on folio.positions for select to authenticated
  using (folio.is_portfolio_owned_by_current_user(folio_id));

create policy "positions_insert"
  on folio.positions for insert to authenticated
  with check (folio.is_portfolio_owned_by_current_user(folio_id));

create policy "positions_update"
  on folio.positions for update to authenticated
  using (folio.is_portfolio_owned_by_current_user(folio_id))
  with check (folio.is_portfolio_owned_by_current_user(folio_id));

create policy "positions_delete"
  on folio.positions for delete to authenticated
  using (folio.is_portfolio_owned_by_current_user(folio_id));

-- Quotes: read-only for anon/authenticated; writes via service_role only
create policy "quotes_select"
  on folio.quotes for select to anon, authenticated
  using (true);

revoke insert, update, delete on folio.quotes from anon, authenticated;

-- =============================================================================
-- After running: Supabase Dashboard -> Settings -> API
-- Under "Extra search path" add:  folio
-- =============================================================================
