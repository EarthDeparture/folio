// Shared auth helper for all proxy API routes.
// Files prefixed with _ are NOT exposed as Vercel endpoints.
import { createClient } from '@supabase/supabase-js';

/**
 * Verifies the Supabase JWT from the Authorization header.
 * Returns a service-role Supabase client on success (used for cache writes),
 * or sends a 401 and returns null on failure.
 */
export async function authenticate(req, res) {
  const token = req.headers.authorization?.replace('Bearer ', '').trim();
  if (!token) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }

  const sb = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { db: { schema: 'folio' } }
  );

  const { data: { user }, error } = await sb.auth.getUser(token);
  if (error || !user) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }

  return sb; // service-role client — can write to folio.quotes
}
