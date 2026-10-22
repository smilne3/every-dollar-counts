import { NextResponse, after } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { decrypt } from '@/lib/crypto'
import { plaidEnv } from '@/lib/plaid'
import { plaidLogSafe } from '@/lib/plaid-errors'
import { storeAccounts, syncAndStore } from '@/lib/ingest'
import { shouldSyncTransactions } from '@/lib/sync-policy'
import { markRecovered } from '@/lib/item-status'
import { suggestCategories } from '@/lib/category-suggest'

// Plaid calls this — there is no user session. Three jobs:
//  - ITEM webhooks that mean "the login is broken or about to break"  -> mark the item
//  - ITEM LOGIN_REPAIRED, "the login was fixed outside this app"      -> clear the mark, pull it
//  - TRANSACTIONS webhooks that mean "fresh data is ready"            -> pull it
//
// Why this route exists (it was originally deferred): PENDING_EXPIRATION and PENDING_DISCONNECT
// are webhook codes, NOT API error codes — they never arrive as thrown errors, so without a
// receiver they cannot be observed at all. Plaid is force-migrating Bank of America Items through
// late 2026 with a one-week PENDING_DISCONNECT warning; this is the only thing that surfaces it.
// It is also what tells us a first transaction pull has finished, the thing most likely to make a
// real link look empty and tempt a slot-burning re-link.

const BREAKING = new Set([
  'ERROR',
  'PENDING_EXPIRATION',
  'PENDING_DISCONNECT',
  'USER_PERMISSION_REVOKED',
  // Fired when the user revokes access at the bank's own portal. For a balances-only
  // investments/loan item this is the ONLY breakage signal — those items never call
  // transactions/sync, and /accounts/get returns cached balances without erroring — so dropping it
  // would show stale balances forever with no banner.
  'USER_ACCOUNT_REVOKED',
])
const DATA_READY = new Set([
  'INITIAL_UPDATE',
  'HISTORICAL_UPDATE',
  'DEFAULT_UPDATE',
  'SYNC_UPDATES_AVAILABLE',
])

export async function POST(req: Request) {
  // after() shares this route's max duration, which starts now: the suggestion job's deadline
  // counts from here (lib/category-suggest.ts RUN_DEADLINE_MS).
  const startedAt = Date.now()
  // Shared secret on the URL registered with Plaid. This is a pragmatic guard, not Plaid's full
  // JWT verification (/webhook_verification_key/get + ES256). What it buys and doesn't: it stops
  // anonymous internet noise, but a leaked URL is a leaked credential. The blast radius is small —
  // a forged call can mark a bank broken or trigger a sync, never read data out.
  const key = new URL(req.url).searchParams.get('key')
  if (!process.env.PLAID_WEBHOOK_SECRET || key !== process.env.PLAID_WEBHOOK_SECRET) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  const body = await req.json().catch(() => null)
  if (!body?.item_id) return NextResponse.json({ ok: true })

  const { webhook_type, webhook_code, item_id, error } = body

  const { data: item, error: itemError } = await supabaseAdmin
    .from('plaid_items')
    .select('id, household_id, access_token_encrypted, cursor, products, status, plaid_env')
    .eq('item_id', item_id)
    .maybeSingle()
  // A failed read is not an unknown item (#91). Acknowledged, this webhook would be gone for good:
  // no sync for new transactions, no needs_reconnect for a broken bank. A 500 makes Plaid deliver
  // it again, which is what a transient failure needs; this read is cheap and safe to repeat,
  // unlike the sync below. The log carries the webhook's ids and the database's error, nothing else:
  // no row came back, so there is no token in hand to leak.
  if (itemError) {
    console.error('[plaid] webhook item read failed', {
      item_id,
      webhook_type,
      webhook_code,
      code: itemError.code,
      message: itemError.message,
    })
    return NextResponse.json({ error: 'could not read the item' }, { status: 500 })
  }
  // Unknown item (e.g. one abandoned by a failed exchange, or from another environment).
  // Acknowledge so Plaid stops retrying.
  if (!item || item.plaid_env !== plaidEnv) return NextResponse.json({ ok: true })

  if (webhook_type === 'ITEM' && BREAKING.has(webhook_code)) {
    const { error: writeError } = await supabaseAdmin
      .from('plaid_items')
      .update({
        status: 'needs_reconnect',
        status_detail: error?.error_code ?? webhook_code,
      })
      .eq('id', item.id)
    // A failed write loses what a failed read would (#91): acknowledged, the bank stays 'ok' and the
    // "isn't syncing" banner never shows, and for a balances-only item this webhook is the only sign
    // of a broken login. Setting a status is safe to repeat, so a 500 lets Plaid deliver it again.
    if (writeError) {
      console.error('[plaid] webhook status write failed', {
        item_id,
        webhook_type,
        webhook_code,
        code: writeError.code,
        message: writeError.message,
      })
      return NextResponse.json({ error: 'could not record the item status' }, { status: 500 })
    }
    return NextResponse.json({ ok: true })
  }

  // The login was fixed without this app's update flow, for example in another app that uses Plaid
  // (#194). Plaid's docs say to stop asking for a reconnect then (ItemLoginRepairedWebhook in
  // node_modules/plaid/dist/api.d.ts). Marked ok, as Reconnect marks it, the bank counts as syncing
  // again: Settings stops saying "Connection lost", Refresh stops skipping it, and the "isn't
  // syncing" banner and the hidden savings average go.
  if (webhook_type === 'ITEM' && webhook_code === 'LOGIN_REPAIRED') {
    // Only a bank marked for a broken login, the one thing Plaid says has ended. The filters are in
    // the write, so Postgres judges the bank as it is when the write lands, and a late or repeated
    // delivery can't overwrite a status recorded since: a Refresh's failure after a Reconnect here,
    // or another ITEM webhook's mark. A bank marked for another reason stays marked. A login Plaid
    // has said will expire (PENDING_EXPIRATION, PENDING_DISCONNECT) still will, and access revoked
    // at the bank is still revoked. Only a webhook says the first, and for a balances-only bank the
    // second, so cleared here, the warning would be gone for good.
    const { error: writeError } = await supabaseAdmin
      .from('plaid_items')
      .update({ status: 'ok', status_detail: null })
      .eq('id', item.id)
      .eq('status', 'needs_reconnect')
      .eq('status_detail', 'ITEM_LOGIN_REQUIRED')
    // Only logged, unlike the needs_reconnect write's failure above: that one, lost, would hide a
    // broken bank, and this one leaves the bank saying to reconnect, as it did before, which is
    // free. So Plaid isn't asked to deliver it again, and the pull below still runs.
    if (writeError) {
      console.error('[plaid] webhook status write failed', {
        item_id,
        webhook_type,
        webhook_code,
        code: writeError.code,
        message: writeError.message,
      })
    }
    // Then what the bank missed while its login was broken, as Reconnect pulls it. Plaid has said
    // the login works, so the pull runs as for a bank that is ok, whatever the write found. A failed
    // pull never fails the webhook, and a bank marked ok above stays ok, as after Reconnect: the next
    // Refresh pulls it again.
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
      console.error('[plaid] webhook sync failed', item.id, plaidLogSafe(e))
    }
    return NextResponse.json({ ok: true })
  }

  if (webhook_type === 'TRANSACTIONS' && DATA_READY.has(webhook_code)) {
    try {
      const token = decrypt(item.access_token_encrypted)
      await storeAccounts(item.household_id, item.id, token)
      if (shouldSyncTransactions({ products: item.products, status: item.status })) {
        await syncAndStore({
          id: item.id,
          household_id: item.household_id,
          access_token: token,
          cursor: item.cursor,
        })
      }
      // Recovered on its own, as on Refresh (#191). A failed write is only logged, as there: the
      // data is in, and the next sync that succeeds writes it again.
      const writeError = await markRecovered(item)
      if (writeError) {
        console.error('[plaid] webhook status write failed', {
          item_id,
          webhook_type,
          webhook_code,
          code: writeError.code,
          message: writeError.message,
        })
      }
    } catch (e) {
      // Never fail the webhook — Plaid retries, and a 500 loop helps nobody. The Refresh button is
      // the backstop.
      console.error('[plaid] webhook sync failed', item.id, plaidLogSafe(e))
    }
    // Jev suggestions (#28 spec §14.5), as the Refresh route does, once Plaid has its answer. The
    // Refresh route may schedule a run for the same rows; that costs tokens only.
    const household_id = item.household_id
    after(() => suggestCategories(household_id, { startedAt }).catch((e) => console.error('[suggest] failed', household_id, e instanceof Error ? e.message : String(e))))
  }

  return NextResponse.json({ ok: true })
}
