import { NextResponse } from 'next/server'
import { isAuthRetryableFetchError } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { plaidEnv } from '@/lib/plaid'
import { assertEnvMatchesDatabase, envGuardResponse } from '@/lib/app-env'
import { unknownIfLost } from '@/lib/lost-reply'

// Upsert the household's home value. One manual asset named 'Home' per household (unique constraint
// on household_id, name), so re-saving updates it and refreshes updated_at — which drives the
// stale-value nudge on the dashboard.
//
// Every message here may be shown verbatim (HomeValueCard does), so none carries the database's
// words; those go to the log. Echoing `error.message` would put raw Postgres in front of the person
// ("duplicate key value violates unique constraint manual_assets_household_id_name_key").
const TRY_AGAIN = 'That could not be saved. Please try again.'
const fail = (status: number, error: string) => NextResponse.json({ error }, { status })

export async function POST(req: Request) {
  // 1. Validate before touching the database. Tolerate a currency-formatted string ("$750,000") as
  //    well as a number — the client strips it too, but be defensive at the boundary. Nothing else
  //    is a value, and nor is an empty string, which Number() would read as 0.
  const body = (await req.json().catch(() => null)) as { value?: unknown } | null
  const value = body?.value
  const text = typeof value === 'number' || typeof value === 'string' ? String(value).replace(/[$,\s]/g, '') : ''
  const v = text === '' ? NaN : Number(text)
  if (!Number.isFinite(v) || v < 0) return fail(400, 'Enter your home value, e.g. 750000 or $750,000.')

  // 2. Sign-in and household, as app/api/budgets/route.ts: 503 if Supabase Auth is unreachable,
  //    401; 500 if the membership read fails, 403.
  const supabase = await createClient()
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()
  // Only an unreachable Supabase Auth leaves the session's state unknown; see the categorize route.
  if (isAuthRetryableFetchError(authError)) {
    console.error('[manual-assets] auth check failed', { code: authError.code, message: authError.message })
    return fail(503, TRY_AGAIN)
  }
  if (!user) return fail(401, 'Your session ended. Sign in again.')
  const { data: m, error: mError } = await supabase.from('memberships').select('household_id').limit(1).maybeSingle()
  // A failed read is not "no household" (#162).
  if (mError) {
    console.error('[manual-assets] membership read failed', { code: mError.code, message: mError.message })
    return fail(500, TRY_AGAIN)
  }
  if (!m) return fail(403, "Your account isn't part of a household.")
  const household_id = m.household_id as string

  // Guarding the write is why lib/manual-assets.ts never needs a plaid_env read filter: a
  // wrong-environment row cannot be created in the first place (#23). Its 409 and 500 are the
  // messages worth surfacing: "please try again" cannot fix a misconfiguration.
  try {
    await assertEnvMatchesDatabase()
  } catch (e) {
    return envGuardResponse(e, {
      tag: '[manual-assets]',
      mismatch: 'This app is pointed at a database from a different environment. Nothing saved.',
      unreadable: 'Could not verify which database this is, so nothing was saved.',
    })
  }

  // 3. Write. Unlike a plain update (app/api/household/timezone/route.ts), an upsert that RLS
  //    refuses errors rather than matching nothing: Postgres never silently skips its update half.
  //    So there is no count to check. One the database never answered may have written the value,
  //    so its outcome is unknown (lib/lost-reply.ts).
  const { error, status } = await supabase.from('manual_assets').upsert(
    {
      household_id,
      name: 'Home',
      value: v,
      plaid_env: plaidEnv,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'household_id,name' }
  )
  if (error) {
    console.error('[manual-assets] upsert failed', { household_id, code: error.code, message: error.message })
    return unknownIfLost(status, error) ?? fail(500, TRY_AGAIN)
  }
  // When the value was written, by the server's clock: HomeValueCard refills what it sent only from a
  // page that read the value after this, so the time is taken after the write, not before (#174).
  return NextResponse.json({ ok: true, savedAt: Date.now() })
}
