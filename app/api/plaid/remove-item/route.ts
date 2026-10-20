import { NextResponse } from 'next/server'
import { isAuthRetryableFetchError } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { decrypt } from '@/lib/crypto'
import { plaidClient, plaidEnv } from '@/lib/plaid'
import { plaidLogSafe, isAlreadyRemoved, plaidAnswered } from '@/lib/plaid-errors'

// Disconnect a bank: remove it at Plaid, THEN delete our record. Deleting the plaid_items row
// cascades to accounts (002) and, via the FK added in 010, on to its transactions — so nothing is
// left counting toward spending.
//
// BankList shows every message here as it stands, so each says what is true of the bank on its
// path (#165): until Plaid removes it nothing has changed, so it is still connected; once Plaid has,
// it is disconnected whatever then happens to the row. None carries the database's words; those go
// to the log.
const NOT_DISCONNECTED = 'That bank was not disconnected. Please try again.'
const fail = (status: number, error: string) => NextResponse.json({ error }, { status })

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { itemId?: unknown } | null
  const itemId = body?.itemId
  if (typeof itemId !== 'string' || itemId === '') {
    return fail(400, 'That bank was not disconnected. Refresh and try again.')
  }

  // Sign-in and household, as app/api/budgets/route.ts: 503 if Supabase Auth is unreachable, 401;
  // 500 if the membership read fails, 403.
  const supabase = await createClient()
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()
  if (isAuthRetryableFetchError(authError)) {
    console.error('[plaid] remove-item auth check failed', { code: authError.code, message: authError.message })
    return fail(503, NOT_DISCONNECTED)
  }
  if (!user) return fail(401, 'Your session ended. Sign in again.')
  const { data: membership, error: mError } = await supabase
    .from('memberships')
    .select('household_id')
    .limit(1)
    .maybeSingle()
  // A failed read is not "no household" (#46).
  if (mError) {
    console.error('[plaid] remove-item membership read failed', { code: mError.code, message: mError.message })
    return fail(500, NOT_DISCONNECTED)
  }
  if (!membership) return fail(403, "Your account isn't part of a household.")

  const { data: item, error: itemError } = await supabaseAdmin
    .from('plaid_items')
    .select('id, household_id, access_token_encrypted, plaid_env')
    .eq('id', itemId)
    .maybeSingle()
  // Nor is it a bank that has gone.
  if (itemError) {
    console.error('[plaid] remove-item read failed', { itemId, code: itemError.code, message: itemError.message })
    return fail(500, NOT_DISCONNECTED)
  }
  // Disconnected already, from this phone or the other one. BankList reloads on a 404, so it drops
  // off the list.
  if (!item || item.household_id !== membership.household_id) {
    return fail(404, "That bank isn't connected any more.")
  }
  // Refuse across environments, like reconnect and create-link-token do (#23). Without this the
  // route is silently destructive: a sandbox access token sent to production itemRemove fails with
  // INVALID_ACCESS_TOKEN, which lib/plaid-errors.ts treats as "already removed" and swallows — so
  // the delete below runs anyway, cascading a real bank's accounts and transactions away while the
  // live Plaid connection is never revoked, its slot stays spent, and the UI reports success.
  if (item.plaid_env !== plaidEnv) {
    return NextResponse.json(
      { error: 'That bank was linked in a different environment and cannot be disconnected here.' },
      { status: 409 }
    )
  }

  // Decrypt OUTSIDE the try. The access token is the ONLY way to revoke this connection at Plaid.
  // If we cannot decrypt it (rotated or lost TOKEN_ENCRYPTION_KEY, corrupted ciphertext) we must
  // not delete the row — doing so would leave a live connection to a real bank login that this app
  // can never revoke, while the UI cheerfully reports "disconnected" and the slot stays spent.
  let accessToken: string
  try {
    accessToken = decrypt(item.access_token_encrypted)
  } catch (e) {
    console.error('[plaid] cannot decrypt token; refusing to delete row', item.id, plaidLogSafe(e))
    return NextResponse.json(
      { error: 'Could not read this bank’s saved credential, so it was NOT disconnected.' },
      { status: 500 }
    )
  }

  // Swallow ONLY "it is already gone there". Any other failure keeps the row so the user can
  // retry, rather than silently orphaning a live connection.
  try {
    await plaidClient.itemRemove({ access_token: accessToken })
  } catch (e) {
    if (!isAlreadyRemoved(e)) {
      console.error('[plaid] itemRemove failed', item.id, plaidLogSafe(e))
      // Refused by Plaid, nothing changed there. Unanswered, the removal may have landed. Trying
      // again settles it either way, since an Item already gone is swallowed above.
      return fail(
        502,
        plaidAnswered(e)
          ? 'Plaid could not disconnect that bank just now. Nothing was changed — try again.'
          : "Plaid didn't answer, so that bank may or may not be disconnected. Try again."
      )
    }
  }

  const { error } = await supabaseAdmin.from('plaid_items').delete().eq('id', item.id)
  // Plaid has removed it, so it is disconnected, but it still shows. Trying again finishes it:
  // itemRemove then finds it gone, which is swallowed above.
  if (error) {
    console.error('[plaid] remove-item delete failed', { itemId: item.id, code: error.code, message: error.message })
    return fail(500, 'That bank was disconnected at Plaid but is still in your list. Please try again.')
  }

  return NextResponse.json({ ok: true })
}
