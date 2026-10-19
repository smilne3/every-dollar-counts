import 'server-only'
import { supabaseAdmin } from '@/lib/supabase/admin'

export type ManualAsset = { id: string; name: string; value: number; updated_at: string }

// NOTE: the pure `sumManualAssets` lives in lib/dashboard.ts (with the rest of the net-worth math)
// so it stays importable in unit tests — this module pulls in the service-role client at load.

// Read a household's manual assets. plaid_items/accounts reads in server components already go
// through the service-role client scoped by household_id; keep this consistent.
//
// Throws on a failed read (#91). An empty list is a claim that there is no house: on the dashboard
// and the net-worth breakdown that drops its full value from net worth, because the mortgage is
// still subtracted as a live liability. The money pages let this reach app/(app)/error.tsx;
// Settings catches it so its other cards still render.
export async function listManualAssets(householdId: string): Promise<ManualAsset[]> {
  const { data, error } = await supabaseAdmin
    .from('manual_assets')
    .select('id, name, value, updated_at')
    .eq('household_id', householdId)
    .order('name')
  if (error) {
    const code = error.code ? `${error.code} ` : ''
    throw new Error(`could not read manual assets: ${code}${error.message}`)
  }
  // No data and no error is not "no assets" either (#46).
  if (!data) throw new Error('could not read manual assets: read returned no data and no error')
  return data as ManualAsset[]
}
