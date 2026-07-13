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
    await supabaseAdmin.from('accounts').upsert(rows, { onConflict: 'account_id' })
  }
}

// Sync transactions for one item and persist the changes + final cursor.
// Takes the PLAINTEXT access token (caller decrypts).
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
    await supabaseAdmin.from('transactions').upsert(upserts, { onConflict: 'plaid_transaction_id' })
  }
  if (removed.length) {
    await supabaseAdmin
      .from('transactions')
      .update({ removed: true })
      .in(
        'plaid_transaction_id',
        removed.map((r) => r.transaction_id)
      )
  }
  await supabaseAdmin.from('plaid_items').update({ cursor: next_cursor }).eq('id', item.id)

  return { added: added.length, modified: modified.length, removed: removed.length }
}
