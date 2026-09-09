import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isValidTimeZone } from '@/lib/clock'

// Set the household's timezone. Follows app/api/manual-assets/route.ts: the household is resolved
// server-side from memberships (the client sends only the zone), and the database's own words are
// logged rather than shown.
export async function POST(req: Request) {
  const { timezone } = await req.json().catch(() => ({}) as { timezone?: unknown })
  const tz = typeof timezone === 'string' ? timezone.trim() : ''
  // Validated here because it cannot be validated in the schema: Postgres has no way to check an
  // IANA name from a column constraint, and Intl is the only authority available.
  if (!tz || !isValidTimeZone(tz)) {
    return NextResponse.json({ error: 'That is not a timezone we recognise.' }, { status: 400 })
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: m } = await supabase.from('memberships').select('household_id').limit(1).single()
  if (!m) return NextResponse.json({ error: 'no household' }, { status: 403 })

  const { error, count } = await supabase
    .from('households')
    .update({ timezone: tz }, { count: 'exact' })
    .eq('id', m.household_id)

  // Two failures, and the second is the interesting one. Before #73 households had only a select
  // policy, so an update matched zero rows and Supabase reported SUCCESS — a save that appeared to
  // work, refreshed, and showed the old value forever. Checking the row count is what stops that
  // being invisible if the policy ever goes missing again.
  if (error) {
    console.error('[household/timezone] update failed', error.message)
    return NextResponse.json({ error: 'That could not be saved. Please try again.' }, { status: 500 })
  }
  if (!count) {
    console.error('[household/timezone] update matched no rows — is the update policy present?')
    return NextResponse.json({ error: 'That could not be saved. Please try again.' }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
