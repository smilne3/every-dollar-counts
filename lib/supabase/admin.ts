import 'server-only'
import { createClient } from '@supabase/supabase-js'
import { fetchWithReadDeadline } from './read-deadline'

// service_role key bypasses RLS — server-only. Used for sign-in and invites, Plaid's syncs and webhooks,
// the environment guard, and the page reads that need it, which scope themselves by household id.
export const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: fetchWithReadDeadline },
  }
)
