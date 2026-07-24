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

export async function listItemsForHousehold(householdId: string): Promise<ItemSummary[]> {
  const { data } = await supabaseAdmin
    .from('plaid_items')
    .select('id, institution_name, status, status_detail, products, created_at')
    .eq('household_id', householdId)
    // Items from another Plaid environment are not actionable here — their tokens are meaningless
    // against this environment's API, and showing them would invite a pointless reconnect.
    .eq('plaid_env', plaidEnv)
    .order('created_at')
  return (data ?? []) as ItemSummary[]
}
