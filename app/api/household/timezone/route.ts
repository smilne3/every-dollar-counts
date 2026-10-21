import { NextResponse } from 'next/server'
import { isAuthRetryableFetchError } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { isValidTimeZone } from '@/lib/clock'
import { unknownIfLost } from '@/lib/lost-reply'

// Set the household's timezone (TimezoneCard). The household is resolved server-side from
// memberships (the client sends only the zone). Every message here may be shown verbatim
// (TimezoneCard does), so none carries the database's words; those go to the log.
const TRY_AGAIN = 'That could not be saved. Please try again.'
const fail = (status: number, error: string) => NextResponse.json({ error }, { status })

export async function POST(req: Request) {
  // A body of JSON null parses, so it is read with ?. rather than destructured.
  const body = (await req.json().catch(() => null)) as { timezone?: unknown } | null
  const tz = typeof body?.timezone === 'string' ? body.timezone.trim() : ''
  // Validated here because it cannot be validated in the schema: Postgres has no way to check an
  // IANA name from a column constraint, and Intl is the only authority available.
  if (!tz || !isValidTimeZone(tz)) return fail(400, 'That is not a timezone we recognise.')

  // Sign-in and household, as app/api/budgets/route.ts: 503 if Supabase Auth is unreachable, 401;
  // 500 if the membership read fails, 403.
  const supabase = await createClient()
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()
  // Only an unreachable Supabase Auth leaves the session's state unknown; see the categorize route.
  if (isAuthRetryableFetchError(authError)) {
    console.error('[household/timezone] auth check failed', { code: authError.code, message: authError.message })
    return fail(503, TRY_AGAIN)
  }
  if (!user) return fail(401, 'Your session ended. Sign in again.')

  const { data: m, error: mError } = await supabase.from('memberships').select('household_id').limit(1).maybeSingle()
  // A failed read is not "no household" (#162).
  if (mError) {
    console.error('[household/timezone] membership read failed', { code: mError.code, message: mError.message })
    return fail(500, TRY_AGAIN)
  }
  if (!m) return fail(403, "Your account isn't part of a household.")
  const household_id = m.household_id as string

  const { error, count, status } = await supabase
    .from('households')
    .update({ timezone: tz }, { count: 'exact' })
    .eq('id', household_id)

  // Two failures, and the second is the interesting one. Before #73 households had only a select
  // policy, so an update matched zero rows and Supabase reported SUCCESS — a save that appeared to
  // work, refreshed, and showed the old value forever. Checking the row count is what stops that
  // being invisible if the policy ever goes missing again. An update the database never answered is
  // neither: it may have written the zone, so its outcome is unknown (lib/lost-reply.ts).
  if (error) {
    console.error('[household/timezone] update failed', { household_id, code: error.code, message: error.message })
    return unknownIfLost(status, error) ?? fail(500, TRY_AGAIN)
  }
  if (!count) {
    console.error('[household/timezone] update matched no rows — is the update policy present?', { household_id })
    return fail(500, TRY_AGAIN)
  }

  // When the zone was written, by the server's clock: TimezoneCard follows the server only from a
  // page that read the zone after this, so the time is taken after the write, not before (#182).
  return NextResponse.json({ ok: true, savedAt: Date.now() })
}
