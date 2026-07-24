import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { decrypt } from '@/lib/crypto'
import { plaidEnv } from '@/lib/plaid'
import { plaidErrorCode } from '@/lib/plaid-errors'
import { storeAccounts, syncAndStore } from '@/lib/ingest'
import { shouldSyncTransactions } from '@/lib/sync-policy'

// Plaid calls this — there is no user session. Two jobs:
//  - ITEM webhooks that mean "the login is broken or about to break"  -> mark the item
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
])
const DATA_READY = new Set([
  'INITIAL_UPDATE',
  'HISTORICAL_UPDATE',
  'DEFAULT_UPDATE',
  'SYNC_UPDATES_AVAILABLE',
])

export async function POST(req: Request) {
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

  const { data: item } = await supabaseAdmin
    .from('plaid_items')
    .select('id, household_id, access_token_encrypted, cursor, products, status, plaid_env')
    .eq('item_id', item_id)
    .maybeSingle()
  // Unknown item (e.g. one abandoned by a failed exchange, or from another environment).
  // Acknowledge so Plaid stops retrying.
  if (!item || item.plaid_env !== plaidEnv) return NextResponse.json({ ok: true })

  if (webhook_type === 'ITEM' && BREAKING.has(webhook_code)) {
    await supabaseAdmin
      .from('plaid_items')
      .update({
        status: 'needs_reconnect',
        status_detail: error?.error_code ?? webhook_code,
      })
      .eq('id', item.id)
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
    } catch (e) {
      // Never fail the webhook — Plaid retries, and a 500 loop helps nobody. The Refresh button is
      // the backstop.
      console.error('[plaid] webhook sync failed', item.id, plaidErrorCode(e) ?? e)
    }
  }

  return NextResponse.json({ ok: true })
}
