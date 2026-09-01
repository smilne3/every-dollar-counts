import 'server-only'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { plaidClient } from '@/lib/plaid'
import { syncItem } from '@/lib/sync'
import { clampReimbursable } from '@/lib/reimbursements'
import { assertEnvMatchesDatabase } from '@/lib/app-env'

// Fetch a Plaid item's accounts and upsert them (also refreshes cached balances).
export async function storeAccounts(householdId: string, plaidItemId: string, accessToken: string) {
  // Before the network call, not after: a wrong-environment write must cost nothing (#23).
  await assertEnvMatchesDatabase()
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

// The upsert payload for one Plaid transaction.
//
// EXPORTED so a test can assert what is NOT in it. PostgREST's ON CONFLICT DO UPDATE writes exactly
// the keys present here, which is the only reason user-owned columns (`user_category`,
// `reimbursable_amount`, `reimbursable_note`) survive a re-sync. Adding one of them to this object
// would silently clobber the user's own data on every sync — see tests/unit/ingest-reimbursable.test.ts.
export function transactionUpsertRow(
  t: {
    account_id: string
    transaction_id: string
    amount: number
    date: string
    name: string
    merchant_name?: string | null
    personal_finance_category?: { primary?: string; detailed?: string; confidence_level?: string | null } | null
  },
  householdId: string
) {
  return {
    household_id: householdId,
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
  // Backstop. The sync, webhook and reconnect callers already filter items by plaid_env, so this
  // should be unreachable from them -- it is here so a FUTURE caller cannot reopen #23.
  await assertEnvMatchesDatabase()
  const { added, modified, removed, next_cursor } = await syncItem(
    item.access_token,
    item.cursor ?? undefined
  )

  const upserts = [...added, ...modified].map((t) => transactionUpsertRow(t, item.household_id))

  // A `modified` transaction can arrive with a SMALLER amount than the one already stored (an
  // authorisation settling lower). If the stored mark now exceeds it, the upsert violates the
  // reimbursable_amount CHECK and the entire sync throws — taking every later transaction with it.
  // Lower the mark to what the transaction is now worth, then let the upsert proceed.
  if (modified.length) {
    const ids = modified.map((t) => t.transaction_id)
    const { data: marked, error: clampSelectErr } = await supabaseAdmin
      .from('transactions')
      .select('plaid_transaction_id, reimbursable_amount')
      .in('plaid_transaction_id', ids)
      .not('reimbursable_amount', 'is', null)
    if (clampSelectErr) throw new Error(`reimbursable-amount clamp select failed: ${clampSelectErr.message}`)

    for (const row of marked ?? []) {
      const incoming = modified.find((t) => t.transaction_id === row.plaid_transaction_id)
      if (!incoming) continue
      const clamped = clampReimbursable(Number(row.reimbursable_amount), incoming.amount)
      if (clamped !== Number(row.reimbursable_amount)) {
        const { error: clampUpdateErr } = await supabaseAdmin
          .from('transactions')
          .update({ reimbursable_amount: clamped })
          .eq('plaid_transaction_id', row.plaid_transaction_id)
        if (clampUpdateErr) throw new Error(`reimbursable-amount clamp update failed: ${clampUpdateErr.message}`)
      }
    }
  }

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
