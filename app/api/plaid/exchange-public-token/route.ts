import { NextResponse } from 'next/server'
import { plaidClient } from '@/lib/plaid'
import { encrypt } from '@/lib/crypto'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { storeAccounts, syncAndStore } from '@/lib/ingest'

export async function POST(req: Request) {
  const { public_token, institution_name } = await req.json()
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

  // Exchange the public token for a long-lived access token (server-side only).
  const { data: ex } = await plaidClient.itemPublicTokenExchange({ public_token })
  const accessToken = ex.access_token

  // Store the item with the encrypted token (never leaves the server).
  const { data: item, error: itemErr } = await supabaseAdmin
    .from('plaid_items')
    .insert({
      household_id,
      item_id: ex.item_id,
      access_token_encrypted: encrypt(accessToken),
      institution_name: institution_name ?? null,
    })
    .select('id')
    .single()
  if (itemErr || !item) {
    return NextResponse.json({ error: itemErr?.message ?? 'store failed' }, { status: 400 })
  }

  await storeAccounts(household_id, item.id, accessToken)
  const counts = await syncAndStore({ id: item.id, household_id, access_token: accessToken })

  return NextResponse.json({ ok: true, ...counts })
}
