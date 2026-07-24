import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { decrypt } from '@/lib/crypto'
import { plaidEnv } from '@/lib/plaid'
import { storeAccounts, syncAndStore } from '@/lib/ingest'
import { shouldSyncTransactions } from '@/lib/sync-policy'
import { classifyPlaidError, plaidErrorCode } from '@/lib/plaid-errors'

// A bank whose sync failed maps to one of these, and each is a different sentence on screen.
const STATUS_FOR = {
  reconnect: 'needs_reconnect',
  action_at_bank: 'action_at_bank',
  temporary: 'temporarily_unavailable',
  config: 'config_error',
} as const

// Refresh: re-fetch balances and pull new transactions for every linked bank in the caller's
// household. Triggered by the "Refresh" button (and by the webhook route when Plaid says new
// data is ready).
export async function POST() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: membership } = await supabase
    .from('memberships')
    .select('household_id')
    .limit(1)
    .single()
  if (!membership) return NextResponse.json({ error: 'no household' }, { status: 403 })
  const household_id = membership.household_id

  // Only items belonging to THIS Plaid environment. All environments share one database, so a
  // sandbox item linked from a laptop after go-live would otherwise be looped here, fail with
  // INVALID_ACCESS_TOKEN, and (before the catch-all below) take every real bank down with it.
  const { data: items } = await supabaseAdmin
    .from('plaid_items')
    .select('id, household_id, access_token_encrypted, cursor, products, status, institution_name')
    .eq('household_id', household_id)
    .eq('plaid_env', plaidEnv)

  let added = 0,
    modified = 0,
    removed = 0,
    brokenNow = 0,
    failed = 0,
    skipped = 0
  const problems: { bank: string; status: string; code: string }[] = []

  for (const item of items ?? []) {
    // A bank with a broken login stays skipped until the user reconnects it — hammering it
    // achieves nothing and can lock the account at the institution.
    if (item.status === 'needs_reconnect') {
      skipped++
      continue
    }
    try {
      const token = decrypt(item.access_token_encrypted)
      await storeAccounts(item.household_id, item.id, token)
      if (shouldSyncTransactions({ products: item.products, status: item.status })) {
        const c = await syncAndStore({
          id: item.id,
          household_id: item.household_id,
          access_token: token,
          cursor: item.cursor,
        })
        added += c.added
        modified += c.modified
        removed += c.removed
      }
      // Recovered on its own (the bank came back up, the lock cleared, and so on).
      if (item.status !== 'ok') {
        await supabaseAdmin
          .from('plaid_items')
          .update({ status: 'ok', status_detail: null })
          .eq('id', item.id)
      }
    } catch (e) {
      // NOTHING rethrows. One sick bank must never stop the others — that is the entire point of
      // this loop, and sandbox never produced the errors that make it matter. Production does:
      // INSTITUTION_DOWN, rate limits, ITEM_LOCKED, PASSWORD_RESET_REQUIRED, and a failed decrypt
      // are all live possibilities. Rethrowing here would 500 the whole refresh and leave every
      // bank after this one silently unsynced.
      const code = plaidErrorCode(e) ?? 'UNKNOWN_ERROR'
      const status = STATUS_FOR[classifyPlaidError(e)]
      if (status === 'needs_reconnect') brokenNow++
      else failed++
      problems.push({ bank: item.institution_name ?? 'A bank', status, code })
      console.error('[plaid] sync failed for item', item.id, code)
      await supabaseAdmin
        .from('plaid_items')
        .update({ status, status_detail: code })
        .eq('id', item.id)
      continue
    }
  }

  return NextResponse.json({
    ok: true,
    banks: items?.length ?? 0,
    added,
    modified,
    removed,
    brokenNow,
    failed,
    skipped,
    problems,
  })
}
