import { NextResponse } from 'next/server'
import { plaidClient, plaidEnv } from '@/lib/plaid'
import { plaidErrorCode } from '@/lib/plaid-errors'
import { encrypt } from '@/lib/crypto'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { storeAccounts, syncAndStore } from '@/lib/ingest'
import { shouldSyncTransactions } from '@/lib/sync-policy'

// Only the three product strings we support; default to transactions.
function normalizeProducts(input: unknown): string[] {
  const list = Array.isArray(input) ? input : []
  const out = list.filter((p) => p === 'transactions' || p === 'investments' || p === 'liabilities')
  return out.length ? (out as string[]) : ['transactions']
}

export async function POST(req: Request) {
  const { public_token, institution_name, products } = await req.json()
  if (!public_token) {
    return NextResponse.json({ error: 'public_token required' }, { status: 400 })
  }

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
    console.error('[plaid] public token exchange failed', plaidErrorCode(e) ?? e)
    return NextResponse.json(
      { error: "Couldn't finish connecting that bank. Check Settings before trying again." },
      { status: 502 }
    )
  }

  const { data: item, error: itemErr } = await supabaseAdmin
    .from('plaid_items')
    .insert({
      household_id,
      item_id: itemId,
      access_token_encrypted: encrypt(accessToken),
      institution_name: institution_name ?? null,
      products: productList,
      // Stamp the environment. All environments share one database, and a sandbox token fails
      // against production with an error that reconnecting cannot fix — see migration 010.
      plaid_env: plaidEnv,
    })
    .select('id')
    .single()

  // If we cannot store it, we hold the only copy of the access token. Abandoning it here would
  // leave a live connection to a real bank that nothing can ever revoke, and would silently spend
  // one of ten unrefundable slots. Tear it down at Plaid; log the id either way so it can be
  // removed by hand if that also fails.
  if (itemErr || !item) {
    console.error('[plaid] failed to store item', itemId, itemErr?.message)
    try {
      await plaidClient.itemRemove({ access_token: accessToken })
      console.error('[plaid] orphaned item removed at Plaid', itemId)
    } catch (e) {
      console.error('[plaid] ALSO failed to remove orphaned item — remove it by hand', itemId, e)
    }
    return NextResponse.json(
      { error: 'Could not save that bank. Nothing was connected — safe to try again.' },
      { status: 400 }
    )
  }

  // Balances come in for every item type — this is what makes brokerage and loan net worth work.
  try {
    await storeAccounts(household_id, item.id, accessToken)
  } catch (e) {
    // The bank IS connected and stored; only the first balance pull failed. Say so plainly rather
    // than reporting a failure, which would invite a duplicate link and a second spent slot.
    console.error('[plaid] initial storeAccounts failed', item.id, plaidErrorCode(e) ?? e)
    return NextResponse.json({
      ok: true,
      warning: 'Bank connected, but its balances have not arrived yet. Press Refresh in a moment.',
    })
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
      console.error('[plaid] initial sync failed', item.id, plaidErrorCode(e) ?? e)
      return NextResponse.json({
        ok: true,
        warning:
          'Bank connected. Transactions can take a few minutes to a few hours to arrive on a first connection — press Refresh again shortly. Do not re-link.',
      })
    }
  }

  return NextResponse.json({ ok: true, ...counts })
}
