import { NextResponse } from 'next/server'
import { isAuthRetryableFetchError } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'

// Add an email to the household's invite allowlist. They join on their first
// sign-in (Google or email link) — no invite email is sent.
//
// Every message here may be shown verbatim (InvitePartnerForm does), so none carries the database's
// words; those go to the log.
const TRY_AGAIN = 'That could not be saved. Please try again.'
const fail = (status: number, error: string) => NextResponse.json({ error }, { status })

export async function POST(req: Request) {
  // 1. Validate before touching the database.
  const body = (await req.json().catch(() => null)) as { email?: unknown; household_id?: unknown } | null
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''
  const household_id = typeof body?.household_id === 'string' ? body.household_id : ''
  if (!email) return fail(400, "Enter your partner's email address.")
  // InvitePartnerForm always sends the household the page shows; a request without one has nothing
  // to save.
  if (!household_id) return fail(400, 'That could not be saved. Refresh and try again.')

  // 2. Sign-in, as app/api/budgets/route.ts: 503 if Supabase Auth is unreachable, 401.
  const supabase = await createClient()
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()
  // Only an unreachable Supabase Auth leaves the session's state unknown; see the categorize route.
  if (isAuthRetryableFetchError(authError)) {
    console.error('[household/invite] auth check failed', { code: authError.code, message: authError.message })
    return fail(503, TRY_AGAIN)
  }
  if (!user) return fail(401, 'Your session ended. Sign in again.')

  // 3. Verify the caller belongs to this household (RLS-scoped read: a caller sees only their own
  //    memberships). A failed read is not "not your household" (#162).
  const { data: mine, error: mError } = await supabase
    .from('memberships')
    .select('household_id')
    .eq('household_id', household_id)
    .limit(1)
    .maybeSingle()
  if (mError) {
    console.error('[household/invite] membership read failed', { household_id, code: mError.code, message: mError.message })
    return fail(500, TRY_AGAIN)
  }
  if (!mine) return fail(403, "Your account isn't part of this household.")

  // 4. Write. An upsert that RLS refuses errors rather than matching nothing, so there is no count
  //    to check (see app/api/manual-assets/route.ts).
  const { error } = await supabase.from('invites').upsert({ email, household_id }, { onConflict: 'email' })
  if (error) {
    console.error('[household/invite] upsert failed', { household_id, code: error.code, message: error.message })
    return fail(500, TRY_AGAIN)
  }

  return NextResponse.json({ ok: true })
}
