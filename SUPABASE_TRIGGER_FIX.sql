-- ═══════════════════════════════════════════════════════════════
-- FIX FOR: NOT NULL ERROR ON 'owner' COLUMN
-- Issue: Trigger set_portfolio_owner() can't find public.current_user_id()
-- Solution: Use auth.uid() directly in the trigger
-- ═══════════════════════════════════════════════════════════════

-- Drop old trigger (with the broken helper function call)
drop trigger if exists trg_set_portfolio_owner on folio.portfolios;

-- Drop the broken helper function
drop function if exists folio.set_portfolio_owner();

-- Create a NEW trigger that uses auth.uid() directly (no helper function)
-- This works regardless of search path issues
create or replace function folio.set_portfolio_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Set owner to auth.uid() if not already set
  -- Using auth.uid() directly avoids the search path issue with current_user_id()
  new.owner := coalesce(new.owner, auth.uid());
  return new;
end;
$$;

-- Recreate the trigger
drop trigger if exists trg_set_portfolio_owner on folio.portfolios;
create trigger trg_set_portfolio_owner
  before insert on folio.portfolios
  for each row
  execute function folio.set_portfolio_owner();

-- ═══════════════════════════════════════════════════════════════
-- VERIFICATION
-- ═══════════════════════════════════════════════════════════════
-- After running this script, test:
-- 1. Sign in to FOLIO
-- 2. Create a new portfolio
-- 3. Check that owner is set (not NULL)
-- ═══════════════════════════════════════════════════════════════
