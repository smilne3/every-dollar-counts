import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { plaidEnv } from '@/lib/plaid'
import { assertEnvMatchesDatabase, envGuardResponse } from '@/lib/app-env'

// Upsert the household's home value. One manual asset named 'Home' per household (unique constraint
// on household_id, name), so re-saving updates it and refreshes updated_at — which drives the
// stale-value nudge on the dashboard.
export async function POST(req: Request) {
  const { value } = await req.json().catch(() => ({}) as { value?: unknown })
  // Tolerate a currency-formatted string ("$750,000") as well as a number — the client strips it
  // too, but be defensive at the boundary.
  const v = Number(String(value).replace(/[$,\s]/g, ''))
  if (!Number.isFinite(v) || v < 0) {
    return NextResponse.json({ error: 'a non-negative value is required' }, { status: 400 })
  }
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const { data: m } = await supabase.from('memberships').select('household_id').limit(1).single()
  if (!m) return NextResponse.json({ error: 'no household' }, { status: 403 })

  // Guarding the write is why lib/manual-assets.ts never needs a plaid_env read filter: a
  // wrong-environment row cannot be created in the first place (#23).
  try {
    await assertEnvMatchesDatabase()
  } catch (e) {
    return envGuardResponse(e, {
      tag: '[manual-assets]',
      mismatch: 'This app is pointed at a database from a different environment. Nothing saved.',
      unreadable: 'Could not verify which database this is, so nothing was saved.',
    })
  }

  const { error } = await supabase.from('manual_assets').upsert(
    {
      household_id: m.household_id,
      name: 'Home',
      value: v,
      plaid_env: plaidEnv,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'household_id,name' }
  )
  // Log the database's words, do not SHOW them. HomeValueCard now renders whatever this route
  // says, so echoing `error.message` would put raw Postgres at the user ("duplicate key value
  // violates unique constraint manual_assets_household_id_name_key"). The guard's 409 and 500
  // above are the messages worth surfacing; a failed upsert is not.
  if (error) {
    console.error('[manual-assets] upsert failed', error.message)
    return NextResponse.json({ error: "Couldn't save that. Please try again." }, { status: 400 })
  }
  return NextResponse.json({ ok: true })
}
