# Supabase Authentication Implementation Plan

## What you've already done (Supabase schema)
- ✅ Added `owner uuid` to `folio.portfolios`
- ✅ Created `public.current_user_id()` → `auth.uid()`
- ✅ Created `folio.is_portfolio_owned_by_current_user(p_folio_id uuid)`
- ✅ Updated RLS to authenticated-only (revoke anon write privileges)
- ✅ Quotes: SELECT for anon, INSERT/UPDATE/DELETE for service_role
- ✅ Indexes on `owner` and `folio_id`

---

## What I need to implement in application code

### 1. Authentication Integration (HIGH PRIORITY)

**Question:** Do you want:
- **Option A:** Full Sign Up / Sign In UI (email/password, magic link, etc.)?
- **Option B:** Pre-built UI from Supabase (Auth UI components) that I configure?
- **Option C:** Minimal - just backend auth integration, you'll add UI later?

**Your notes say:**
> "Ensure authenticated requests include a valid Supabase JWT... Validate JWT on client startup"

**My recommendation:** Use **Option C** first (auth integration without UI), then we can add UI.

---

### 2. Portfolio Creation

**Your notes say:**
> "Add DB trigger to set owner if NULL... When creating portfolios, set the owner correctly"

**Implementation:**
```javascript
// Create portfolio with owner
const { data, error } = await supabase
  .from('portfolios')
  .insert({ name: 'My Portfolio' })
  .select()
  .single(); // owner should be auto-set by trigger
```

**Question:** Should I implement a BEFORE INSERT trigger in the SQL, or rely on your existing setup?

---

### 3. Position Operations (CRUD)

**Requirements:**
- All operations must use authenticated sessions
- Handle 403/permission-denied gracefully
- Ensure folio_id is UUID

**Current code location:** `DB.listPositions()`, `DB.upsertPosition()`, `DB.deletePosition()`

**Changes needed:**
- Remove anonymous access
- Ensure all calls go through authenticated session
- Add error handling for permission denials

**Question:** Do you want the code to:
- **Option A:** Require user to be logged in before creating portfolio/positions?
- **Option B:** Try to authenticate automatically and show error if failed?
- **Option C:** Just let it fail with 403 and show user-friendly message?

---

### 4. Error Handling

**Your notes say:**
> "Treat 403/permission-denied responses from Supabase as expected RLS behavior... Log failing query and current user's uid for debugging"

**Implementation:**
```javascript
if (error?.code === 'PGRST014' || error?.status === 403) {
  // Permission denied
  toast('You don\'t have permission to access this portfolio', 'error');
  console.error('[FOLIO] Permission denied for user:', auth.user()?.id);
}
```

**Question:** Do you want:
- **Option A:** Only console.log for debugging (silent to user)?
- **Option B:** Show toast notification to user with generic message?

---

### 5. JWT Validation

**Your notes say:**
> "Ensure supabase.auth.getSession() or onAuthStateChange populates the client with the token before making DB calls"

**Implementation:**
```javascript
import { createClient } from '@supabase/supabase-js';
import { supabase } from './supabaseClient'; // export client

// In main.js
const { data: { session } } = await supabase.auth.getSession();
if (!session) {
  // No auth - show setup screen or redirect to login
  $('setup-screen').style.display = 'flex';
  $('app-shell').style.display = 'none';
}
```

**Question:** Should I:
- **Option A:** Show a "Login Required" screen when user isn't authenticated?
- **Option B:** Redirect to Supabase Auth URL for login?
- **Option C:** Show error toast and let user try again?

---

### 6. Remove Internal Helper Calls

**Your notes say:**
> "Do not call helper functions from unprivileged SQL in application code... Remove any client-side usage of folio.is_portfolio_owned_by_current_user"

**Current code:** This function is never called in the app (it's only in RLS policies), so this is already satisfied.

**Verification:** I'll confirm no calls exist.

---

### 7. Service Role Key

**Your notes say:**
> "service_role key is only used in server-only code and never in client bundles"

**Question:** Do you want me to add a server-side API route (e.g., `/api/quotes`) that uses service_role for quotes, so the client doesn't need AV_KEY?

**Trade-off:**
- **With AV_KEY in client:** Simpler, but AV key visible in bundle
- **With server API:** AV key hidden, but more complex setup

**My recommendation:** For MVP, keep AV_KEY in client (it's a free API key anyway).

---

### 8. Current User ID extraction

**Your notes say:**
> "Ensure folio_id and owner are passed as proper UUID strings"

**Question:** Do you want me to add a helper function to safely extract `auth.user()?.id` from session?

```javascript
function getCurrentUserId() {
  const { data: { session } } = supabase.auth.getSession();
  return session?.user?.id;
}
```

---

## Priority Implementation Order

1. **Authentication Integration** (get session on app load)
2. **Show "Login Required" screen** when not authenticated
3. **Update RLS checks** (add auth validation)
4. **Test authentication flow** (create portfolio, add position, verify RLS)
5. **Add error handling** for permission denials
6. **Optional:** Full Auth UI (Sign Up/Sign In)

---

## Open Questions (Need your input)

1. **Auth UI:** Do you want full Sign Up/Sign In UI, or just backend integration first?
2. **Login flow:** What should happen when user is not authenticated?
   - Show "Login Required" screen?
   - Redirect to Supabase Auth?
3. **Position creation:** How should we handle errors when user creates position in non-owned portfolio?
4. **Service Role:** Do you want quotes API route to hide AV_KEY from client?

---

## What I'm Ready to Implement

Once you answer these questions, I can:
1. Add authentication check on app load
2. Show login screen when not authenticated
3. Update all DB operations to use authenticated session
4. Add proper error handling for permission denials
5. Remove anonymous access completely
6. Test the flow end-to-end

**Estimated time:** 15-30 minutes to implement + test.

---

## Your input needed

Please answer:
1. **Auth UI preference:** (A, B, or C)
2. **Not authenticated behavior:** (A, B, or C)
3. **Position creation error handling:** (Show error or redirect?)
4. **Service Role API route:** (Yes or No)
