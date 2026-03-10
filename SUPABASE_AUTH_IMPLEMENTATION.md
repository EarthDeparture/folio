# FOLIO — Supabase Authentication Implementation

**Date:** 2026-03-10
**Status:** Complete
**Commit:** d3160b2

---

## Overview

FOLIO uses Supabase Auth for user authentication with email/password (MVP). Authentication is handled entirely client-side via JavaScript, with row-level security (RLS) enforcing data ownership at the database level.

---

## Auth Flow

### 1. Landing Page → Auth
- User lands on `/index.html`
- If already logged in → redirect to `/dashboard.html` (session check in landing page script)
- If not logged in → user sees sign-in/sign-up options

### 2. Sign Up
```
User enters email + password
      ↓
auth.js: signUp(email, password)
      ↓
Supabase: sb.auth.signUp({ email, password })
      ↓
If session exists → redirect to /dashboard.html
If no session → show "Account created, please sign in" message
```

### 3. Sign In
```
User enters email + password
      ↓
auth.js: signIn(email, password)
      ↓
Supabase: sb.auth.signInWithPassword({ email, password })
      ↓
On success → redirect to /dashboard.html
On error → show error message in UI
```

### 4. Dashboard (Authenticated)
- Dashboard page checks session on load via `main.js: checkAuth()`
- If no session → redirect to `/auth.html`
- Session persisted in localStorage via Supabase auth client

### 5. Sign Out
```
User clicks "Sign Out" button
      ↓
dashboard.js: S.db.auth.signOut()
      ↓
Clears session → redirect to /auth.html
```

---

## Database Schema (Auth Integration)

### portfolios Table
```sql
id         uuid        primary key default gen_random_uuid(),
owner      uuid        not null,                     -- auth.uid()
name       text        not null check (char_length(name) between 1 and 50),
created_at timestamptz not null default now(),
updated_at timestamptz not null default now()
```

**Owner column:**
- Set by Supabase Auth (`auth.uid()`)
- Auto-set by BEFORE INSERT trigger: `folio.set_portfolio_owner()`
- **Security:** Trigger ensures owner is always set, preventing client impersonation

### RLS Policies (portfolios)
```sql
-- Read: Only user's own portfolios
CREATE POLICY "portfolios_select"
  ON folio.portfolios for select
  TO authenticated
  USING (owner = public.current_user_id());

-- Insert: Authenticated users can create portfolios
CREATE POLICY "portfolios_insert"
  ON folio.portfolios for insert
  TO authenticated
  WITH CHECK (true);  -- trigger sets owner

-- Update: Only portfolio owner can modify
CREATE POLICY "portfolios_update"
  ON folio.portfolios for update
  TO authenticated
  USING (owner = public.current_user_id())
  WITH CHECK (owner = public.current_user_id());

-- Delete: Only portfolio owner can delete
CREATE POLICY "portfolios_delete"
  ON folio.portfolios for delete
  TO authenticated
  USING (owner = public.current_user_id());
```

### positions Table
```sql
id         uuid    primary key default gen_random_uuid(),
folio_id   uuid    not null references folio.portfolios(id) on delete cascade,
symbol     text    not null check (char_length(symbol) between 1 and 10),
shares     numeric not null check (shares > 0),
avg_cost   numeric not null check (avg_cost >= 0),
color      text,
created_at timestamptz not null default now(),
updated_at timestamptz not null default now(),
unique(folio_id, symbol)
```

### positions RLS
```sql
-- Can only read positions from user's portfolios
CREATE POLICY "positions_select"
  ON folio.positions for select
  TO authenticated
  USING (folio.is_portfolio_owned_by_current_user(folio_id));

-- Can only insert positions into user's portfolios
CREATE POLICY "positions_insert"
  ON folio.positions for insert
  TO authenticated
  WITH CHECK (folio.is_portfolio_owned_by_current_user(folio_id));

-- Can only update positions in user's portfolios
CREATE POLICY "positions_update"
  ON folio.positions for update
  TO authenticated
  USING (folio.is_portfolio_owned_by_current_user(folio_id))
  WITH CHECK (folio.is_portfolio_owned_by_current_user(folio_id));

-- Can only delete positions from user's portfolios
CREATE POLICY "positions_delete"
  ON folio.positions for delete
  TO authenticated
  USING (folio.is_portfolio_owned_by_current_user(folio_id));
```

### quotes Table (No RLS on INSERT)
```sql
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
```

**Read:** Anon + authenticated (SELECT only)
**Write:** service_role only (server-side Alpha Vantage job)

---

## Client-Side Implementation

### Auth Utility (`src/auth.js`)
```javascript
export const sb = createClient(SUPABASE_URL, VITE_SUPABASE_ANON_KEY, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true,
    flowType: 'pkce',
  },
});

export async function signIn(email, password) {
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw error;
  window.location.href = '/dashboard.html';
}

export async function signUp(email, password) {
  const { data, error } = await sb.auth.signUp({ email, password });
  if (error) throw error;

  if (data.session) {
    window.location.href = '/dashboard.html';
  } else {
    // Show "account created" message, switch to sign-in tab
  }
}
```

### Dashboard Guard (`src/main.js`)
```javascript
export async function checkAuth() {
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) {
      window.location.href = '/auth.html';
      return false;
    }
    return true;
  } catch (error) {
    console.error('Auth check failed:', error);
    window.location.href = '/auth.html';
    return false;
  }
}

export async function signOut() {
  await sb.auth.signOut();
  window.location.href = '/auth.html';
}
```

### Dashboard App (`src/dashboard.js`)
```javascript
// Already has complete auth integration:
// - init() checks session on load
// - onAuthStateChange handles SIGNED_OUT event
// - UI reflects user's portfolio list
// - RLS enforces data ownership (DB layer, not UI layer)
```

---

## Security Model

### Owner-Based RLS (Not Browser ID)
**Before:** Browser ID (`localStorage.uuid`) + permissive RLS
**After:** Auth-based (`auth.uid()`) + strict RLS

**Why:**
- Real security at database level
- No client-side bypass
- Database enforces ownership (trust but verify)

### Prevention of Impersonation
- `folio.set_portfolio_owner()` trigger auto-sets `owner = auth.uid()` on INSERT
- Clients **cannot** bypass this trigger
- Even if client omits `owner` column, database sets it automatically
- RLS policies call `public.current_user_id()` which returns `auth.uid()`

### Quote Cache Security
- `folio.quotes` table has RLS: SELECT allowed for anon/authenticated
- INSERT/UPDATE/DELETE **revoked** for anon/authenticated
- Only `service_role` can write quotes (server-side Alpha Vantage job)
- Prevents client-side quote manipulation

---

## Features

### Currently Implemented
✅ Email/password authentication
✅ Sign up → auto-redirect to dashboard if email verified (disabled for MVP)
✅ Sign in → auto-redirect to dashboard
✅ Sign out → redirect to auth page
✅ Session persistence (localStorage)
✅ Session check on page load (auth guard)
✅ `#signup` hash auto-selects signup tab
✅ Error handling for auth failures
✅ Loading states during auth operations
✅ Owner-based RLS (portfolios + positions)
✅ Auto-set owner on portfolio creation (trigger)
✅ Quote cache write by service_role only

### Planned Future Features
⏳ Google OAuth (custom domain required)
⏳ Email verification (after custom domain)
⏳ Remember me (persistence)
⏳ Password reset flow
⏳ Multi-factor authentication (MFA)

---

## Setup Steps

### 1. Run Supabase SQL Script
```sql
-- In Supabase SQL Editor (project: earthdeparture-hub)
-- File: setup.sql (in repo root)
-- Run the entire script
```

### 2. Update API Settings
Navigate to Supabase dashboard → Settings → API:
1. **Extra search path:** Add `folio`
2. This allows DB to find `folio` schema functions

### 3. Create Environment Variables
Create `.env` in project root:
```
VITE_SUPABASE_ANON_KEY=your_anon_key_here
VITE_AV_KEY=your_alpha_vantage_key_here
```

### 4. Test Locally
```bash
npm run dev
```

### 5. Deploy to Vercel
1. Push to GitHub (done: commit d3160b2)
2. Import repo in Vercel
3. Set environment variables (same as step 3 above)
4. Deploy

---

## Troubleshooting

### Error: "Permission denied"
- **Cause:** User not authenticated or RLS blocking access
- **Fix:** Check if user is logged in → sign out → sign in again

### Error: "User is not authorized"
- **Cause:** User trying to access another user's portfolio
- **Fix:** This is expected RLS behavior — each user can only see their own data

### Auth session not persisting
- **Cause:** Cookie blocking or localStorage disabled
- **Fix:** Try in a different browser or clear cookies

### Quote cache not updating
- **Cause:** service_role key not set (server-side job)
- **Fix:** Quote writes only work on server — this is expected

---

## Code Flow Diagram

```
┌─────────────┐
│   User      │
└──────┬──────┘
       │
       ▼
┌─────────────┐     ┌──────────────┐
│ index.html  │────▶│ auth.html    │
└──────┬──────┘     └──────┬───────┘
       │                    │
       │                    │ signUp/signIn
       ▼                    ▼
┌───────────────┐   ┌──────────────────┐
│ dashboard.html│──▶│ Supabase Auth    │
└───────┬───────┘   │ (PKCE flow)      │
        │           └────────┬─────────┘
        │                    │
        │  checkAuth()       │
        ▼                    │
┌───────────────┐            │
│ dashboard.js  │◄───────────┘
│ (full app)    │
└───────┬───────┘
        │
        │ RLS enforces ownership
        ▼
┌──────────────────┐
│ Supabase DB      │
│ - portfolios     │
│ - positions      │
│ - quotes         │
└──────────────────┘
```

---

## References

- **Supabase Auth Docs:** https://supabase.com/docs/guides/auth
- **RLS Policy Pattern:** https://supabase.com/docs/guides/auth/row-level-security
- **Vite Auth Guard:** https://vitejs.dev/guide/build.html#conditional-loading
- **Current Repo:** https://github.com/EarthDeparture/folio

---

**Implementation Status:** ✅ Complete (d3160b2)
