import { NextResponse } from 'next/server'
import { isAuthRetryableFetchError } from '@supabase/supabase-js'
import { plaidClient, plaidEnv } from '@/lib/plaid'
import { plaidLogSafe } from '@/lib/plaid-errors'
import { encrypt } from '@/lib/crypto'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { storeAccounts, syncAndStore } from '@/lib/ingest'
import { recordSlotUsed } from '@/lib/plaid-slots'
import { shouldSyncTransactions } from '@/lib/sync-policy'
import { assertEnvMatchesDatabase, envGuardResponse } from '@/lib/app-env'
import { replyWasLost } from '@/lib/lost-reply'

// The longest this route may run, in seconds (#165). The browser waits longer than this before it
// says the bank may have connected (EXCHANGE_TIMEOUT_MS, components/plaid-link-context.ts), so by
// then the exchange has finished or the platform has stopped it, and the reload shows which. Giving
// up any sooner, and calling it a failure, would invite a second link: a duplicate that spends a
// second of the ten connections (#51). 300 is Vercel's default and Hobby's ceiling. Set here, it
// holds whatever the project's dashboard default becomes.
export const maxDuration = 300

// LinkButton and the OAuth return page show these as they stand, each followed by its own advice to
// check Settings first, since every new attempt spends a connection. Link has already created the
// Item at Plaid by the time this runs.
const NOT_FINISHED = "Couldn't finish connecting that bank."
const BALANCES_LATER = 'Bank connected, but its balances have not arrived yet. Press Refresh in a moment.'
const fail = (status: number, error: string) => NextResponse.json({ error }, { status })

// Only the three product strings we support; default to transactions.
function normalizeProducts(input: unknown): string[] {
  const list = Array.isArray(input) ? input : []
  const out = list.filter((p) => p === 'transactions' || p === 'investments' || p === 'liabilities')
  return out.length ? (out as string[]) : ['transactions']
}

// The bank as stored: its row's id, or null when it is stored but its row could not be read back.
// When it is not stored, the caller, which holds the only copy of the token, tears the Item down.
type Stored = { stored: true; id: string | null } | { stored: false }

// Stores the bank, token and all (#173). An insert whose reply was lost may or may not have landed,
// so it is tried once more, and item_id, plaid_items' one unique column, settles which: a second
// insert refused as a duplicate (23505) means the first one landed. On a first insert, a duplicate
// can only be the same bank stored already, so it is not torn down either: that would leave the
// stored row a dead bank whose next sync fails.
//
// What is left is torn down by the caller: a refusal, or a second insert whose reply was lost too.
// We hold the only copy of the token, and an Item that nothing can remove at Plaid goes on being
// billed for good. If the first insert did land after all, its row is a dead bank, which shows in
// the list and can be disconnected, so the log says to look for it.
async function storeItem(item: {
  household_id: string
  item_id: string
  accessToken: string
  institution_name: string | null
  products: string[]
}): Promise<Stored> {
  const insert = () =>
    supabaseAdmin
      .from('plaid_items')
      .insert({
        household_id: item.household_id,
        item_id: item.item_id,
        access_token_encrypted: encrypt(item.accessToken),
        institution_name: item.institution_name,
        products: item.products,
        // Stamp the environment. All environments share one database, and a sandbox token fails
        // against production with an error that reconnecting cannot fix — see migration 010.
        plaid_env: plaidEnv,
      })
      .select('id')
      .single()
  // `details` names a lost request's cause: the connection refused, reset or timed out.
  const said = (e: { code?: string; message: string; details?: string | null } | null) => ({
    itemId: item.item_id,
    code: e?.code,
    message: e?.message,
    details: e?.details,
  })

  let result = await insert()
  const firstLost = result.error !== null && replyWasLost(result.status, result.error)
  if (firstLost) {
    console.error('[plaid] no answer storing item; trying once more', said(result.error))
    result = await insert()
  }
  if (result.data) return { stored: true, id: result.data.id }

  if (result.error?.code === '23505') {
    const { data: row, error: readErr } = await supabaseAdmin
      .from('plaid_items')
      .select('id')
      .eq('item_id', item.item_id)
      .maybeSingle()
    if (row) return { stored: true, id: row.id }
    console.error('[plaid] item already stored, but its row could not be read back', said(readErr))
    return { stored: true, id: null }
  }

  console.error(
    firstLost
      ? '[plaid] FAILED to store item after an insert got no answer, which may have landed: tearing it down at Plaid. If it is in the list, disconnect it'
      : '[plaid] failed to store item',
    said(result.error)
  )
  return { stored: false }
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as
    | { public_token?: unknown; institution_name?: unknown; products?: unknown }
    | null
  const public_token = body?.public_token
  if (typeof public_token !== 'string' || public_token === '') return fail(400, NOT_FINISHED)
  const institution_name = typeof body?.institution_name === 'string' ? body.institution_name : null

  // Sign-in and household, as app/api/budgets/route.ts: 503 if Supabase Auth is unreachable, 401;
  // 500 if the membership read fails, 403.
  const supabase = await createClient()
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()
  if (isAuthRetryableFetchError(authError)) {
    console.error('[plaid] exchange auth check failed', { code: authError.code, message: authError.message })
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
    console.error('[plaid] exchange membership read failed', { code: mError.code, message: mError.message })
    return fail(500, NOT_FINISHED)
  }
  if (!membership) return fail(403, "Your account isn't part of a household.")
  const household_id = membership.household_id
  const products = body?.products
  const productList = normalizeProducts(products)

  // THE ITEM ALREADY EXISTS AT PLAID by the time this route runs — Link created it the moment the
  // user finished at their bank. Everything below is us catching up. That asymmetry is why every
  // failure path here has to be loud and has to clean up after itself.
  let accessToken: string
  let itemId: string
  try {
    const { data: ex } = await plaidClient.itemPublicTokenExchange({ public_token })
    accessToken = ex.access_token
    itemId = ex.item_id
  } catch (e) {
    console.error('[plaid] public token exchange failed', plaidLogSafe(e))
    return fail(502, NOT_FINISHED)
  }

  // Record the spent connection HERE, before anything else can fail. The ten are consumed by Link
  // creating the Item, not by us storing it, and /item/remove never gives one back — so a link that
  // dies on the next line still cost one, and the ledger has to say so (#51). Never throws.
  await recordSlotUsed({ householdId: household_id, itemId, institutionName: institution_name ?? null })

  // Before the plaid_items insert, so no wrong-environment bank row can be created (#23) — and
  // deliberately AFTER the exchange above. The Item already exists at Plaid by then, so refusing
  // BEFORE the exchange would not leave the slot unspent; it would only forfeit the one access
  // token /item/remove could ever use, leaving a live authorization against a real bank login
  // that nothing can revoke. The slot is gone either way, so this path takes the token and tears
  // the Item down, exactly like the insert-failure path below. The guard that actually prevents
  // the cost is in create-link-token: it refuses before Link opens, so no Item is ever created.
  // This one is the backstop for a database that changed identity mid-flow.
  try {
    await assertEnvMatchesDatabase()
  } catch (e) {
    console.error('[plaid] environment guard refused an item that already exists at Plaid', itemId)
    try {
      await plaidClient.itemRemove({ access_token: accessToken })
      console.error('[plaid] orphaned item removed at Plaid', itemId)
    } catch (removeErr) {
      // A failed teardown must not replace the guard's own answer: the user still gets the
      // 409/500, and the id is logged so the Item can be removed by hand.
      console.error(
        '[plaid] ALSO failed to remove orphaned item — remove it by hand',
        itemId,
        plaidLogSafe(removeErr)
      )
    }
    return envGuardResponse(e, {
      tag: '[plaid]',
      mismatch:
        'This app is pointed at a database from a different Plaid environment, so linking a ' +
        'bank was refused. Nothing was connected.',
      unreadable: 'Could not verify which database this is, so nothing was connected.',
    })
  }

  const stored = await storeItem({
    household_id,
    item_id: itemId,
    accessToken,
    institution_name: institution_name ?? null,
    products: productList,
  })

  // If we cannot store it, we hold the only copy of the access token. Abandoning it here would
  // leave a live connection to a real bank that nothing can ever revoke, and would silently spend
  // one of ten unrefundable slots. Tear it down at Plaid; log the id either way so it can be
  // removed by hand if that also fails. storeItem has said why, and whether a row may exist anyway.
  if (!stored.stored) {
    try {
      await plaidClient.itemRemove({ access_token: accessToken })
      console.error('[plaid] orphaned item removed at Plaid', itemId)
    } catch (e) {
      console.error('[plaid] ALSO failed to remove orphaned item — remove it by hand', itemId, plaidLogSafe(e))
    }
    // Not "safe to try again": Link spent a connection on this Item, and a new attempt spends
    // another, as the warning beside this message says. Nor "nothing was connected", which is
    // false if the teardown above failed.
    return fail(500, 'Could not save that bank.')
  }
  // Stored, as a duplicate proved, but with no id to pull its data under: Refresh pulls it.
  if (stored.id === null) return NextResponse.json({ ok: true, warning: BALANCES_LATER })
  const item = { id: stored.id }

  // Balances come in for every item type — this is what makes brokerage and loan net worth work.
  try {
    await storeAccounts(household_id, item.id, accessToken)
  } catch (e) {
    // The bank IS connected and stored; only the first balance pull failed. Say so plainly rather
    // than reporting a failure, which would invite a duplicate link and a second spent slot.
    console.error('[plaid] initial storeAccounts failed', item.id, plaidLogSafe(e))
    return NextResponse.json({ ok: true, warning: BALANCES_LATER })
  }

  // Transactions only for transaction items. Note this does NOT error for investment/loan items —
  // it would silently attach the billable Transactions product to them. See lib/sync-policy.ts.
  let counts = { added: 0, modified: 0, removed: 0 }
  if (shouldSyncTransactions({ products: productList, status: 'ok' })) {
    try {
      counts = await syncAndStore({ id: item.id, household_id, access_token: accessToken })
    } catch (e) {
      // Plaid's first pull runs for minutes to hours on a real bank. An empty result here is
      // normal, not broken — and re-linking to "fix" it would spend another slot for nothing.
      console.error('[plaid] initial sync failed', item.id, plaidLogSafe(e))
      return NextResponse.json({
        ok: true,
        warning:
          'Bank connected. Transactions can take a few minutes to a few hours to arrive on a first connection — press Refresh again shortly. Do not re-link.',
      })
    }
  }

  return NextResponse.json({ ok: true, ...counts })
}
