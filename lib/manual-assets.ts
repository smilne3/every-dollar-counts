import 'server-only'
import { supabaseAdmin } from '@/lib/supabase/admin'

export type ManualAsset = { id: string; name: string; value: number; updated_at: string }

// NOTE: the pure `sumManualAssets` lives in lib/dashboard.ts (with the rest of the net-worth math)
// so it stays importable in unit tests — this module pulls in the service-role client at load.

// Read a household's manual assets. plaid_items/accounts reads in server components already go
// through the service-role client scoped by household_id; keep this consistent.
export async function listManualAssets(householdId: string): Promise<ManualAsset[]> {
  const { data } = await supabaseAdmin
    .from('manual_assets')
    .select('id, name, value, updated_at')
    .eq('household_id', householdId)
    .order('name')
  return (data ?? []) as ManualAsset[]
}
