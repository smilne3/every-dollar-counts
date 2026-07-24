import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { decrypt } from '@/lib/crypto'
import { plaidEnv } from '@/lib/plaid'
import { plaidLogSafe } from '@/lib/plaid-errors'
import { storeAccounts, syncAndStore } from '@/lib/ingest'
import { shouldSyncTransactions } from '@/lib/sync-policy'

// Called after Link's update mode succeeds: the item's login is fixed and its access token is
// unchanged, so clear the broken flag and pull whatever we missed while it was down.
// Update mode creates no new Item, so nothing here spends an Item slot.
export async function POST(req: Request) {
  const { itemId } = await req.json().catch(() => ({}) as { itemId?: string })
  if (!itemId) return NextResponse.json({ error: 'itemId required' }, { status: 400 })

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

  const { data: item } = await supabaseAdmin
    .from('plaid_items')
    .select('id, household_id, access_token_encrypted, cursor, products, plaid_env')
    .eq('id', itemId)
    .single()
  if (!item || item.household_id !== membership.household_id) {
    return NextResponse.json({ error: 'not found' }, { status: 403 })
  }
  if (item.plaid_env !== plaidEnv) {
    return NextResponse.json(
      { error: 'That bank was linked in a different environment and cannot be reconnected here.' },
      { status: 409 }
    )
  }

  // Clear the flag first so the item is eligible for the sync below.
  await supabaseAdmin
    .from('plaid_items')
    .update({ status: 'ok', status_detail: null })
    .eq('id', item.id)

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
