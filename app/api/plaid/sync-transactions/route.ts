import { NextResponse, after } from 'next/server'
import { isAuthRetryableFetchError } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { decrypt } from '@/lib/crypto'
import { plaidEnv } from '@/lib/plaid'
import { storeAccounts, syncAndStore } from '@/lib/ingest'
import { shouldSyncTransactions } from '@/lib/sync-policy'
import { markRecovered } from '@/lib/item-status'
import { classifyPlaidError, fromPlaid, plaidErrorCode, plaidLogSafe } from '@/lib/plaid-errors'
import { EnvMismatchError } from '@/lib/app-env'
import { suggestCategories } from '@/lib/category-suggest'

// A bank whose sync failed maps to one of these, and each is a different sentence on screen.
const STATUS_FOR = {
  reconnect: 'needs_reconnect',
  action_at_bank: 'action_at_bank',
  temporary: 'temporarily_unavailable',
  config: 'config_error',
} as const

// RefreshButton shows the refusals below as they stand, so none carries the database's words.
const TRY_AGAIN = "Couldn't refresh. Please try again."
const fail = (status: number, error: string) => NextResponse.json({ error }, { status })

// Refresh: re-fetch balances and pull new transactions for every linked bank in the caller's
// household. Triggered by the "Refresh" button (and by the webhook route when Plaid says new
// data is ready).
export async function POST() {
  // after() shares this route's max duration, which starts now: the suggestion job's deadline
  // counts from here (lib/category-suggest.ts RUN_DEADLINE_MS).
  const startedAt = Date.now()
  // Sign-in and household, as app/api/budgets/route.ts: 503 if Supabase Auth is unreachable, 401;
  // 500 if the membership read fails, 403.
  const supabase = await createClient()
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()
  if (isAuthRetryableFetchError(authError)) {
    console.error('[plaid] sync auth check failed', { code: authError.code, message: authError.message })
    return fail(503, TRY_AGAIN)
  }
  if (!user) return fail(401, 'Your session ended. Sign in again.')

  const { data: membership, error: mError } = await supabase
    .from('memberships')
    .select('household_id')
    .limit(1)
    .maybeSingle()
  // A failed read is not "no household" (#46).
  if (mError) {
    console.error('[plaid] sync membership read failed', { code: mError.code, message: mError.message })
    return fail(500, TRY_AGAIN)
  }
  if (!membership) return fail(403, "Your account isn't part of a household.")
  const household_id = membership.household_id

  // Only items belonging to THIS Plaid environment. All environments share one database, so a
  // sandbox item linked from a laptop after go-live would otherwise be looped here, fail with
  // INVALID_ACCESS_TOKEN, and (before the catch-all below) take every real bank down with it.
  const { data: items, error: itemsError } = await supabaseAdmin
    .from('plaid_items')
    .select('id, household_id, access_token_encrypted, cursor, products, status, institution_name')
    .eq('household_id', household_id)
    .eq('plaid_env', plaidEnv)
  // Nor is a failed read "no banks": every count would be 0, which Refresh would report as nothing
  // new (#46, #119).
  if (itemsError) {
    console.error('[plaid] sync bank read failed', { household_id, code: itemsError.code, message: itemsError.message })
    return fail(500, TRY_AGAIN)
  }

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
      // Recovered on its own (the bank came back up, the lock cleared, and so on), which the webhook
      // records too (#191). Its data did sync, so a failed write doesn't count this bank as a
      // problem; its flag stays stale until the next sync that succeeds.
      const error = await markRecovered(item)
      if (error) console.error('[plaid] sync status write failed', { itemId: item.id, code: error.code, message: error.message })
    } catch (e) {
      // NOTHING rethrows. One sick bank must never stop the others — that is the entire point of
      // this loop, and sandbox never produced the errors that make it matter. Production does:
      // INSTITUTION_DOWN, rate limits, ITEM_LOCKED, PASSWORD_RESET_REQUIRED, and a failed decrypt
      // are all live possibilities. Rethrowing here would 500 the whole refresh and leave every
      // bank after this one silently unsynced.
      // A write in lib/ingest.ts that the database never answered (#173) lands here too, as a
      // throw. It may have landed, so this bank's sync may not have finished, and it is counted as
      // one that needs attention, never as a failed Refresh. Refreshing again is safe: every write
      // there is keyed on the row, and the cursor moves only after them.
      // An environment mismatch is OUR misconfiguration, not the bank's — 010 defines
      // 'config_error' for exactly this and says never to render it as "the bank is having
      // trouble." It carries no Plaid error_code, so classifyPlaidError would fall through to its
      // unknown-codes default of 'temporary' and label every real bank temporarily unavailable.
      // Nor is any other failure of this app's own, outside the calls to Plaid (#189): a database
      // write in lib/ingest.ts, the app_env check that couldn't run, a failed decrypt. Recorded as
      // UNKNOWN_ERROR, it read in Settings as "This bank didn't respond last time." APP_ERROR says
      // whose it was. Its status stays temporarily_unavailable, classifyPlaidError's answer for an
      // error with no code, so Refresh retries it, and the banner and the average still count the
      // bank as behind.
      const envMismatch = e instanceof EnvMismatchError
      const code = envMismatch ? 'ENV_MISMATCH' : fromPlaid(e) ? (plaidErrorCode(e) ?? 'UNKNOWN_ERROR') : 'APP_ERROR'
      const status = envMismatch ? STATUS_FOR.config : STATUS_FOR[classifyPlaidError(e)]
      if (status === 'needs_reconnect') brokenNow++
      else failed++
      problems.push({ bank: item.institution_name ?? 'A bank', status, code })
      // With what failed, so an APP_ERROR in the log says which write. plaidLogSafe, never the raw
      // error: an axios error carries the Plaid secret and the decrypted token.
      console.error('[plaid] sync failed for item', item.id, code, plaidLogSafe(e))
      const { error } = await supabaseAdmin
        .from('plaid_items')
        .update({ status, status_detail: code })
        .eq('id', item.id)
      if (error) console.error('[plaid] sync status write failed', { itemId: item.id, code: error.code, message: error.message })
      continue
    }
  }

  // Jev suggestions (#28 spec §14.5), once the response is sent. Never reaches this response,
  // its status or any bank's health: suggestCategories does not throw, and the catch is a backstop.
  after(() => suggestCategories(household_id, { startedAt }).catch((e) => console.error('[suggest] failed', household_id, e instanceof Error ? e.message : String(e))))

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
