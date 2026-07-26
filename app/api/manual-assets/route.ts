import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { plaidEnv } from '@/lib/plaid'

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
  if (error) return NextResponse.json({ error: error.message }, { status: 400 })
  return NextResponse.json({ ok: true })
}
