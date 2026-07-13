import 'server-only'
import { createClient } from '@supabase/supabase-js'

// service_role key bypasses RLS — server-only, used for invites and data ingest.
export const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
)
