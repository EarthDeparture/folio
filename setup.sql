-- ═══════════════════════════════════════════════════════════════
-- FOLIO SCHEMA — Full Setup
-- Project : earthdeparture-hub (qpkvbgeqmrnvhpgqqbmg)
-- Run in  : Supabase SQL Editor
-- ═══════════════════════════════════════════════════════════════

-- ── SCHEMA ────────────────────────────────────────────────────
create schema if not exists folio;

-- ── PORTFOLIOS ────────────────────────────────────────────────
create table if not exists folio.portfolios (
  id         uuid        primary key default gen_random_uuid(),
  owner      uuid        not null,                     -- auth.uid(), set by trigger
  name       text        not null check (char_length(name) between 1 and 50),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ── POSITIONS ─────────────────────────────────────────────────
create table if not exists folio.positions (
  id         uuid    primary key default gen_random_uuid(),
  folio_id   uuid    not null references folio.portfolios(id) on delete cascade,
  symbol     text    not null check (char_length(symbol) between 1 and 10),
  shares     numeric not null check (shares > 0),
  avg_cost   numeric not null check (avg_cost >= 0),
  color      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(folio_id, symbol)
);

-- ── QUOTES CACHE ──────────────────────────────────────────────
-- Shared quote cache. Written by service_role (server-side job).
-- anon / authenticated users can only SELECT.
create table if not exists folio.quotes (
  symbol             text primary key,
  name               text,
  price              numeric,
  change             numeric,
  changes_percentage numeric,
  market_cap         text,
  pe                 numeric,
  year_high          numeric,
  year_low           numeric,
  dividend_yield     numeric,
  cached_at          timestamptz default now()
);

-- ── INDEXES ───────────────────────────────────────────────────
create index if not exists idx_portfolios_owner     on folio.portfolios(owner);
create index if not exists idx_positions_folio_id   on folio.positions(folio_id);
create index if not exists folio_quotes_cached_at_idx on folio.quotes(cached_at desc);

-- ── HELPER: current_user_id ────────────────────────────────────
-- SECURITY DEFINER so it runs as the function owner, not the caller.
-- Revoked from anon + authenticated; only RLS policies call it.
create or replace function public.current_user_id()
returns uuid
language sql
stable
security definer
as $$
  select auth.uid();
$$;

revoke execute on function public.current_user_id() from anon, authenticated;

-- ── HELPER: is_portfolio_owned_by_current_user ─────────────────
-- Used only in RLS policies. Never call from application code.
create or replace function folio.is_portfolio_owned_by_current_user(p_folio_id uuid)
returns boolean
language sql
stable
security definer
as $$
  select exists (
    select 1 from folio.portfolios
    where id = p_folio_id
      and owner = public.current_user_id()
  );
$$;

revoke execute on function folio.is_portfolio_owned_by_current_user(uuid) from anon, authenticated;

-- ── TRIGGER: auto-set owner on INSERT ──────────────────────────
-- Ensures owner = auth.uid() even if the INSERT omits the column.
-- Prevents clients from impersonating other users.
create or replace function folio.set_portfolio_owner()
returns trigger
language plpgsql
security definer
as $$
begin
  new.owner := coalesce(new.owner, public.current_user_id());
  return new;
end;
$$;

drop trigger if exists trg_set_portfolio_owner on folio.portfolios;
create trigger trg_set_portfolio_owner
  before insert on folio.portfolios
  for each row
  execute function folio.set_portfolio_owner();

-- ── ROW LEVEL SECURITY ────────────────────────────────────────
alter table folio.portfolios enable row level security;
alter table folio.positions  enable row level security;
alter table folio.quotes     enable row level security;

-- Drop any existing policies to ensure a clean slate
drop policy if exists "portfolios_select"  on folio.portfolios;
drop policy if exists "portfolios_insert"  on folio.portfolios;
drop policy if exists "portfolios_update"  on folio.portfolios;
drop policy if exists "portfolios_delete"  on folio.portfolios;
drop policy if exists "positions_select"   on folio.positions;
drop policy if exists "positions_insert"   on folio.positions;
drop policy if exists "positions_update"   on folio.positions;
drop policy if exists "positions_delete"   on folio.positions;
drop policy if exists "quotes_select"      on folio.quotes;
drop policy if exists "Allow all on portfolios" on folio.portfolios;
drop policy if exists "Allow all on positions"  on folio.positions;
drop policy if exists "Allow all on quotes"     on folio.quotes;
drop policy if exists "Allow select on quotes"  on folio.quotes;

-- ── PORTFOLIOS RLS ─────────────────────────────────────────────
create policy "portfolios_select"
  on folio.portfolios for select
  to authenticated
  using (owner = public.current_user_id());

create policy "portfolios_insert"
  on folio.portfolios for insert
  to authenticated
  with check (true);  -- trigger sets owner; no client spoofing possible

create policy "portfolios_update"
  on folio.portfolios for update
  to authenticated
  using (owner = public.current_user_id())
  with check (owner = public.current_user_id());

create policy "portfolios_delete"
  on folio.portfolios for delete
  to authenticated
  using (owner = public.current_user_id());

-- ── POSITIONS RLS ─────────────────────────────────────────────
create policy "positions_select"
  on folio.positions for select
  to authenticated
  using (folio.is_portfolio_owned_by_current_user(folio_id));

create policy "positions_insert"
  on folio.positions for insert
  to authenticated
  with check (folio.is_portfolio_owned_by_current_user(folio_id));

create policy "positions_update"
  on folio.positions for update
  to authenticated
  using  (folio.is_portfolio_owned_by_current_user(folio_id))
  with check (folio.is_portfolio_owned_by_current_user(folio_id));

create policy "positions_delete"
  on folio.positions for delete
  to authenticated
  using (folio.is_portfolio_owned_by_current_user(folio_id));

-- ── QUOTES RLS ────────────────────────────────────────────────
-- anon + authenticated: read only
-- service_role: full access (bypasses RLS, used by server-side jobs)
create policy "quotes_select"
  on folio.quotes for select
  to anon, authenticated
  using (true);

-- Revoke write on quotes from anon / authenticated
revoke insert, update, delete on folio.quotes from anon, authenticated;

-- ── EXTRA SEARCH PATH ─────────────────────────────────────────
-- After running this script:
-- Dashboard → Settings → API → Extra search path → add: folio
-- ═══════════════════════════════════════════════════════════════
