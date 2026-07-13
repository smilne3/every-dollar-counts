import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { decrypt } from '@/lib/crypto'
import { storeAccounts, syncAndStore } from '@/lib/ingest'

// Refresh: re-fetch balances and pull new transactions for every linked bank
// in the caller's household. Triggered by the "Refresh" button (and later, cron).
export async function POST() {
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

  // Read items with the encrypted token via service_role (never exposed to client).
  const { data: items } = await supabaseAdmin
    .from('plaid_items')
    .select('id, household_id, access_token_encrypted, cursor')
    .eq('household_id', household_id)

  let added = 0,
    modified = 0,
    removed = 0
  for (const item of items ?? []) {
    const token = decrypt(item.access_token_encrypted)
    await storeAccounts(item.household_id, item.id, token)
    const c = await syncAndStore({
      id: item.id,
      household_id: item.household_id,
      access_token: token,
      cursor: item.cursor,
    })
    added += c.added
    modified += c.modified
    removed += c.removed
  }

  return NextResponse.json({ ok: true, banks: items?.length ?? 0, added, modified, removed })
}
