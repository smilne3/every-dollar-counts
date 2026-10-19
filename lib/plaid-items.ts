import 'server-only'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { plaidEnv } from '@/lib/plaid'

// Safe, display-only view of a household's linked banks. plaid_items has RLS with no client
// policy, so this reads via service_role — and deliberately selects only non-sensitive columns.
// NEVER add access_token_encrypted here.
export type ItemSummary = {
  id: string
  institution_name: string | null
  status: string
  status_detail: string | null
  products: string[]
  created_at: string
}

// Throws on a failed read (#91). An empty list is a claim that no bank is linked: on the dashboard
// it hides the "isn't syncing" banner, and on Settings it says "No banks connected yet." beside
// the button that spends one of ten lifetime connections (#51). The dashboard lets this reach
// app/(app)/error.tsx; Settings catches it so its other cards still render.
export async function listItemsForHousehold(householdId: string): Promise<ItemSummary[]> {
  const { data, error } = await supabaseAdmin
    .from('plaid_items')
    .select('id, institution_name, status, status_detail, products, created_at')
    .eq('household_id', householdId)
    // Items from another Plaid environment are not actionable here — their tokens are meaningless
    // against this environment's API, and showing them would invite a pointless reconnect.
    .eq('plaid_env', plaidEnv)
    .order('created_at')
  if (error) {
    const code = error.code ? `${error.code} ` : ''
    throw new Error(`could not read linked banks: ${code}${error.message}`)
  }
  // No data and no error is not "no banks" either (#46).
  if (!data) throw new Error('could not read linked banks: read returned no data and no error')
  return data as ItemSummary[]
}
