import 'server-only'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { plaidClient } from '@/lib/plaid'
import { syncItem } from '@/lib/sync'

// Fetch a Plaid item's accounts and upsert them (also refreshes cached balances).
export async function storeAccounts(householdId: string, plaidItemId: string, accessToken: string) {
  const acc = await plaidClient.accountsGet({ access_token: accessToken })
  const rows = acc.data.accounts.map((a) => ({
    household_id: householdId,
    plaid_item_id: plaidItemId,
    account_id: a.account_id,
    name: a.name,
    type: String(a.type),
    subtype: a.subtype ? String(a.subtype) : null,
    current_balance: a.balances.current,
    available_balance: a.balances.available,
    iso_currency_code: a.balances.iso_currency_code,
  }))
  if (rows.length) {
    const { error } = await supabaseAdmin.from('accounts').upsert(rows, { onConflict: 'account_id' })
    if (error) throw new Error(`accounts upsert failed: ${error.message}`)
  }
}

// Sync transactions for one item and persist the changes + final cursor.
// Takes the PLAINTEXT access token (caller decrypts).
//
// CRITICAL: only advance the stored cursor AFTER the transaction writes succeed.
// Plaid never re-sends a change once its cursor moves past it, so persisting the
// cursor on a failed write would lose those transactions permanently. We throw on
// any write error (leaving the cursor untouched) so the next sync retries cleanly.
export async function syncAndStore(item: {
  id: string
  household_id: string
  access_token: string
  cursor?: string | null
}) {
  const { added, modified, removed, next_cursor } = await syncItem(
    item.access_token,
    item.cursor ?? undefined
  )

  const upserts = [...added, ...modified].map((t) => ({
    household_id: item.household_id,
    account_id: t.account_id,
    plaid_transaction_id: t.transaction_id,
    amount: t.amount,
    date: t.date,
    name: t.name,
    merchant_name: t.merchant_name ?? null,
    pfc_primary: t.personal_finance_category?.primary ?? null,
    pfc_detailed: t.personal_finance_category?.detailed ?? null,
    pfc_confidence: t.personal_finance_category?.confidence_level ?? null,
    removed: false,
  }))
  if (upserts.length) {
    const { error } = await supabaseAdmin
      .from('transactions')
      .upsert(upserts, { onConflict: 'plaid_transaction_id' })
    if (error) throw new Error(`transactions upsert failed: ${error.message}`)
  }
  if (removed.length) {
    const { error } = await supabaseAdmin
      .from('transactions')
      .update({ removed: true })
      .in(
        'plaid_transaction_id',
        removed.map((r) => r.transaction_id)
      )
    if (error) throw new Error(`removed-transactions update failed: ${error.message}`)
  }

  // Writes succeeded — safe to advance the cursor now.
  const { error: cursorErr } = await supabaseAdmin
    .from('plaid_items')
    .update({ cursor: next_cursor })
    .eq('id', item.id)
  if (cursorErr) throw new Error(`cursor update failed: ${cursorErr.message}`)

  return { added: added.length, modified: modified.length, removed: removed.length }
}
