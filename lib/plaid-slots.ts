import 'server-only'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { plaidEnv } from '@/lib/plaid'

// The Trial plan's lifetime allowance. Not read from Plaid — there is no API for it — so it is
// stated here and cited: https://plaid.com/docs/account/billing/
export const LIFETIME_SLOTS = 10

// How many connections this household has spent for good.
//
// Counts plaid_slot_ledger, NOT plaid_items: disconnecting deletes the item but never gives the
// slot back, so counting live banks would show the number falling as it is actually being used up.
// Only production Items consume the allowance; sandbox links are free.
//
// Returns null when the count cannot be established — the ledger is display-only, and a page that
// merely wants to print a number must not fail because of it. The caller shows nothing rather than
// a wrong figure, which is the honest reading of "we do not know".
export async function countSlotsUsed(householdId: string): Promise<number | null> {
  if (plaidEnv !== 'production') return null

  const { count, error } = await supabaseAdmin
    .from('plaid_slot_ledger')
    .select('*', { count: 'exact', head: true })
    .eq('household_id', householdId)
    .eq('plaid_env', 'production')

  // Includes the case where migration 018 has not been applied yet: no table, no number, no crash.
  if (error || count == null) return null
  return count
}

// Record that a connection was spent. Called the moment Plaid tells us an Item exists — which is
// BEFORE we store it, because the slot is consumed by Link creating the Item, not by us saving it.
// An abandoned or failed link still costs one.
//
// Never throws. Failing to write a bookkeeping row must not fail the link the user just completed;
// the cost of that is an undercount, which is visible and fixable, against losing a bank connection
// they cannot get back.
export async function recordSlotUsed(input: {
  householdId: string
  itemId: string
  institutionName: string | null
}): Promise<void> {
  const { error } = await supabaseAdmin.from('plaid_slot_ledger').insert({
    household_id: input.householdId,
    item_id: input.itemId,
    institution_name: input.institutionName,
    plaid_env: plaidEnv,
  })
  // A duplicate item_id is a retry of a link already recorded, which is exactly what the unique
  // constraint is for — not worth a log line.
  if (error && error.code !== '23505') {
    console.error('[plaid] could not record a spent connection slot', input.itemId, error.message)
  }
}
