import { NextResponse } from 'next/server'
import { isAuthRetryableFetchError } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { decrypt } from '@/lib/crypto'
import { plaidEnv } from '@/lib/plaid'
import { plaidLogSafe } from '@/lib/plaid-errors'
import { storeAccounts, syncAndStore } from '@/lib/ingest'
import { shouldSyncTransactions } from '@/lib/sync-policy'
import { assertEnvMatchesDatabase, envGuardResponse } from '@/lib/app-env'
import { unknownIfLost } from '@/lib/lost-reply'

// ReconnectButton and the OAuth return page show these as they stand. By the time this runs, Link's
// update mode has fixed the login at Plaid; a failure here means this app did not record it, and
// pressing Reconnect again costs nothing.
const NOT_FINISHED = "Couldn't finish reconnecting that bank. Please try again."
const fail = (status: number, error: string) => NextResponse.json({ error }, { status })

// Called after Link's update mode succeeds: the item's login is fixed and its access token is
// unchanged, so clear the broken flag and pull whatever we missed while it was down.
// Update mode creates no new Item, so nothing here spends an Item slot.
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { itemId?: unknown } | null
  const itemId = body?.itemId
  if (typeof itemId !== 'string' || itemId === '') return fail(400, NOT_FINISHED)

  // Sign-in and household, as app/api/budgets/route.ts: 503 if Supabase Auth is unreachable, 401;
  // 500 if the membership read fails, 403.
  const supabase = await createClient()
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()
  if (isAuthRetryableFetchError(authError)) {
    console.error('[plaid] reconnect auth check failed', { code: authError.code, message: authError.message })
    return fail(503, NOT_FINISHED)
  }
  if (!user) return fail(401, 'Your session ended. Sign in again.')

  const { data: membership, error: mError } = await supabase
    .from('memberships')
    .select('household_id')
    .limit(1)
    .maybeSingle()
  // A failed read is not "no household" (#46).
  if (mError) {
    console.error('[plaid] reconnect membership read failed', { code: mError.code, message: mError.message })
    return fail(500, NOT_FINISHED)
  }
  if (!membership) return fail(403, "Your account isn't part of a household.")

  const { data: item, error: itemError } = await supabaseAdmin
    .from('plaid_items')
    .select('id, household_id, access_token_encrypted, cursor, products, plaid_env')
    .eq('id', itemId)
    .maybeSingle()
  // Nor is it a bank that has gone.
  if (itemError) {
    console.error('[plaid] reconnect read failed', { itemId, code: itemError.code, message: itemError.message })
    return fail(500, NOT_FINISHED)
  }
  if (!item || item.household_id !== membership.household_id) {
    return fail(404, "That bank isn't connected any more.")
  }
  if (item.plaid_env !== plaidEnv) {
    return NextResponse.json(
      { error: 'That bank was linked in a different environment and cannot be reconnected here.' },
      { status: 409 }
    )
  }

  // BEFORE the status write below, not inside the sync that follows it. storeAccounts/syncAndStore
  // now assert this themselves (#23), but by then this route has already cleared status to 'ok' —
  // and its catch answers `{ ok: true, warning: … }`. So without this, an app_env blip would mark a
  // genuinely broken bank healthy and tell the user the reconnect worked. Refuse before the write.
  try {
    await assertEnvMatchesDatabase()
  } catch (e) {
    return envGuardResponse(e, {
      tag: '[plaid]',
      mismatch:
        'This app is pointed at a database from a different Plaid environment. Nothing was changed.',
      unreadable: 'Could not verify which database this is, so nothing was changed.',
    })
  }

  // Clear the flag first so the item is eligible for the sync below.
  const { error: statusError, status: httpStatus } = await supabaseAdmin
    .from('plaid_items')
    .update({ status: 'ok', status_detail: null })
    .eq('id', item.id)
  // Not recorded, the bank still shows as needing a reconnect, and Refresh skips it. Saying it
  // reconnected would leave it that way. A write the database never answered may have recorded it,
  // so its outcome is unknown (lib/lost-reply.ts): the catch-up is left to the next Refresh, and
  // the reload shows whether the bank still needs reconnecting, which costs nothing to do again.
  if (statusError) {
    console.error('[plaid] reconnect status write failed', {
      itemId: item.id,
      code: statusError.code,
      message: statusError.message,
    })
    return unknownIfLost(httpStatus, statusError) ?? fail(500, NOT_FINISHED)
  }

  try {
    const token = decrypt(item.access_token_encrypted)
    await storeAccounts(item.household_id, item.id, token)
    if (shouldSyncTransactions({ products: item.products, status: 'ok' })) {
      await syncAndStore({
        id: item.id,
        household_id: item.household_id,
        access_token: token,
        cursor: item.cursor,
      })
    }
  } catch (e) {
    // The reconnect itself succeeded at Plaid — only the catch-up sync failed. Leave the item
    // marked healthy (the next Refresh will retry) and say so, rather than reporting a failure
    // that would push the user toward disconnecting and relinking, which costs a slot.
    console.error('[plaid] post-reconnect sync failed', item.id, plaidLogSafe(e))
    return NextResponse.json({
      ok: true,
      warning: 'Reconnected. New transactions have not arrived yet — press Refresh in a moment.',
    })
  }

  return NextResponse.json({ ok: true })
}
