import { NextResponse } from 'next/server'
import { CountryCode, Products } from 'plaid'
import { plaidClient, plaidEnv } from '@/lib/plaid'
import { plaidErrorCode, isOutOfItemSlots } from '@/lib/plaid-errors'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { decrypt } from '@/lib/crypto'

// Map the client's requested product strings to Plaid's enum.
// Plaid Link only lists institutions that support EVERY requested product, so these are
// deliberately separate link paths rather than one combined request — asking for all three at
// once would show almost no institutions at all.
function toProducts(input: unknown): Products[] {
  const list = Array.isArray(input) ? input : ['transactions']
  const out: Products[] = []
  if (list.includes('transactions')) out.push(Products.Transactions)
  if (list.includes('investments')) out.push(Products.Investments)
  // Requested only as a key to the door: it is what makes loan-only institutions (mortgage and
  // student-loan servicers) selectable in Link. We ingest balances, not liabilities data. There
  // is deliberately no UI for this today — the household's mortgage is at Wells Fargo, which
  // supports `transactions`, so it arrives through the ordinary bank flow at no extra Item cost.
  if (list.includes('liabilities')) out.push(Products.Liabilities)
  return out.length ? out : [Products.Transactions]
}

// How much transaction history to request. THIS CANNOT BE CHANGED LATER.
// Plaid: "The maximum amount of transaction history to request on an Item cannot be updated if
// Transactions has already been added to the Item. To request older transaction history ... you
// must delete the Item via /item/remove and send the user through Link to create a new Item."
// On the Trial plan that means spending another unrefundable slot. The default is 90 days; the
// dashboard charts six months. 730 costs nothing and is the one number we cannot revisit.
const DAYS_REQUESTED = 730

export async function POST(req: Request) {
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

  const body = await req.json().catch(() => ({}) as Record<string, unknown>)

  // Real banks hand the login off to their own website and return the user here. Without a
  // registered redirect_uri the OAuth institutions (Wells Fargo, Chase, BofA…) will not open.
  const redirect_uri = process.env.PLAID_REDIRECT_URI || undefined
  // Plaid only sends webhooks to Items created WITH a webhook URL, and it cannot be added to an
  // Item afterwards — so this has to be set before the first real bank is linked.
  const webhook = process.env.PLAID_WEBHOOK_URL || undefined

  const base = {
    user: { client_user_id: user.id },
    client_name: 'Every Dollar Counts',
    language: 'en',
    country_codes: [CountryCode.Us],
    ...(redirect_uri ? { redirect_uri } : {}),
    ...(webhook ? { webhook } : {}),
  }

  try {
    // Update mode: reopen an existing item's login (reconnect). No products; uses access_token.
    // This does NOT create a new Item, so it costs no Item slot.
    if (body.mode === 'update' && typeof body.itemId === 'string') {
      const { data: item } = await supabaseAdmin
        .from('plaid_items')
        .select('access_token_encrypted, household_id, plaid_env')
        .eq('id', body.itemId)
        .single()
      if (!item || item.household_id !== membership.household_id) {
        return NextResponse.json({ error: 'not found' }, { status: 403 })
      }
      // Refuse to reconnect an item from a different Plaid environment: its token is meaningless
      // here and the resulting failure would be opaque.
      if (item.plaid_env !== plaidEnv) {
        return NextResponse.json(
          {
            error:
              'That bank was linked in a different environment and cannot be reconnected here.',
          },
          { status: 409 }
        )
      }
      const r = await plaidClient.linkTokenCreate({
        ...base,
        access_token: decrypt(item.access_token_encrypted),
      })
      return NextResponse.json({ link_token: r.data.link_token })
    }

    // Add mode: a new bank. Completing Link from this token is what spends an Item slot.
    const products = toProducts(body.products)
    const r = await plaidClient.linkTokenCreate({
      ...base,
      products,
      // Only meaningful when transactions is among the products, and it MUST be set here rather
      // than on transactions/sync when the Item is initialized with transactions at link time.
      ...(products.includes(Products.Transactions)
        ? { transactions: { days_requested: DAYS_REQUESTED } }
        : {}),
    })
    return NextResponse.json({ link_token: r.data.link_token })
  } catch (e) {
    // Never fail silently. A button that does nothing is the state that tempts a second click,
    // and on the Trial plan a second click can mean a second unrefundable Item.
    if (isOutOfItemSlots(e)) {
      return NextResponse.json(
        {
          error:
            'You have used all 10 of your Plaid bank connections. Disconnecting one does not free a slot.',
        },
        { status: 409 }
      )
    }
    console.error('[plaid] linkTokenCreate failed', plaidErrorCode(e) ?? e)
    return NextResponse.json(
      { error: "Couldn't start the bank connection. Nothing was connected — safe to try again." },
      { status: 502 }
    )
  }
}
