import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { decrypt } from '@/lib/crypto'
import { plaidClient } from '@/lib/plaid'
import { plaidLogSafe, isAlreadyRemoved } from '@/lib/plaid-errors'

// Disconnect a bank: remove it at Plaid, THEN delete our record. Deleting the plaid_items row
// cascades to accounts (002) and, via the FK added in 010, on to its transactions — so nothing is
// left counting toward spending.
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
    .select('id, household_id, access_token_encrypted')
    .eq('id', itemId)
    .single()
  if (!item || item.household_id !== membership.household_id) {
    return NextResponse.json({ error: 'not found' }, { status: 403 })
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
      return NextResponse.json(
        { error: 'Plaid could not disconnect that bank just now. Nothing was changed — try again.' },
        { status: 502 }
      )
    }
  }

  const { error } = await supabaseAdmin.from('plaid_items').delete().eq('id', item.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 400 })

  return NextResponse.json({ ok: true })
}
