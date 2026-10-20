import { NextResponse } from 'next/server'
import { isAuthRetryableFetchError } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'

// Goals (GoalsList): add a goal, update the amount saved toward one, delete one. Every message here
// may be shown verbatim (GoalsList does), so none carries the database's words; those go to the
// log. The goals page reads the table directly, so there is no GET.
const TRY_AGAIN = 'That could not be saved. Please try again.'
const REFRESH = 'That could not be saved. Refresh and try again.'
const GONE = 'That goal no longer exists. Refresh and try again.'
const fail = (status: number, error: string) => NextResponse.json({ error }, { status })

// A finite number, by type: NaN and Infinity have no JSON form and arrive as null, which Number()
// would read as 0 (see app/api/budgets/route.ts).
const isAmount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

type Supabase = Awaited<ReturnType<typeof createClient>>

// Sign-in, as app/api/budgets/route.ts: 503 if Supabase Auth is unreachable, 401 if signed out.
async function signIn(): Promise<Supabase | NextResponse> {
  const supabase = await createClient()
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()
  // Only an unreachable Supabase Auth leaves the session's state unknown; see the categorize route.
  if (isAuthRetryableFetchError(authError)) {
    console.error('[goals] auth check failed', { code: authError.code, message: authError.message })
    return fail(503, TRY_AGAIN)
  }
  if (!user) return fail(401, 'Your session ended. Sign in again.')
  return supabase
}

export async function POST(req: Request) {
  // 1. Validate before touching the database. GoalsList sends only a name and a target above zero.
  const body = (await req.json().catch(() => null)) as { name?: unknown; target_amount?: unknown } | null
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  const target = body?.target_amount
  if (!name || !isAmount(target) || target <= 0) return fail(400, 'Give the goal a name and a target above zero.')

  // 2. Sign-in and household: 500 if the membership read fails, 403 if there is none.
  const supabase = await signIn()
  if (supabase instanceof NextResponse) return supabase
  const { data: m, error: mError } = await supabase.from('memberships').select('household_id').limit(1).maybeSingle()
  // A failed read is not "no household" (#162).
  if (mError) {
    console.error('[goals] membership read failed', { code: mError.code, message: mError.message })
    return fail(500, TRY_AGAIN)
  }
  if (!m) return fail(403, "Your account isn't part of a household.")
  const household_id = m.household_id as string

  // 3. Write.
  const { error } = await supabase.from('goals').insert({ household_id, name, target_amount: target, saved_amount: 0 })
  if (error) {
    console.error('[goals] add failed', { household_id, code: error.code, message: error.message })
    return fail(500, TRY_AGAIN)
  }
  return NextResponse.json({ ok: true })
}

// The update and delete go by id alone: RLS keeps them to the caller's households, as it does the
// goals page's read, which shows every goal the caller can see.
export async function PATCH(req: Request) {
  // 1. Validate before touching the database. GoalsList sends only saved_amount; a field that is
  //    sent must be valid, so a bad one is never dropped while the rest saves.
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
  const id = typeof body?.id === 'string' ? body.id : ''
  if (!body || !id) return fail(400, REFRESH)
  const patch: { saved_amount?: number; name?: string; target_amount?: number } = {}
  if (body.saved_amount !== undefined) {
    if (!isAmount(body.saved_amount)) return fail(400, REFRESH)
    // Refused, not stored as 0: the input's min="0" does not stop a minus sign being typed.
    if (body.saved_amount < 0) return fail(400, "The amount saved can't be negative.")
    patch.saved_amount = body.saved_amount
  }
  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim()) return fail(400, REFRESH)
    patch.name = body.name.trim()
  }
  if (body.target_amount !== undefined) {
    if (!isAmount(body.target_amount) || body.target_amount <= 0) return fail(400, REFRESH)
    patch.target_amount = body.target_amount
  }
  if (Object.keys(patch).length === 0) return fail(400, REFRESH)

  const supabase = await signIn()
  if (supabase instanceof NextResponse) return supabase

  // `count` is what tells "updated it" from "matched nothing". Without it, a goal deleted on the
  // other phone, or a missing update policy (#73), read as saved.
  const { error, count } = await supabase.from('goals').update(patch, { count: 'exact' }).eq('id', id)
  if (error) {
    console.error('[goals] update failed', { id, code: error.code, message: error.message })
    return fail(500, TRY_AGAIN)
  }
  if (!count) {
    // A stale-list refusal: GoalsList reloads on a 404 to show the latest.
    console.error('[goals] update matched no rows (goal deleted, or the update policy is missing)', { id })
    return fail(404, GONE)
  }
  return NextResponse.json({ ok: true })
}

export async function DELETE(req: Request) {
  const body = (await req.json().catch(() => null)) as { id?: unknown } | null
  const id = typeof body?.id === 'string' ? body.id : ''
  if (!id) return fail(400, 'That goal could not be deleted. Refresh and try again.')

  const supabase = await signIn()
  if (supabase instanceof NextResponse) return supabase

  // As the update: a delete that matched nothing did not delete anything.
  const { error, count } = await supabase.from('goals').delete({ count: 'exact' }).eq('id', id)
  if (error) {
    console.error('[goals] delete failed', { id, code: error.code, message: error.message })
    return fail(500, 'That goal could not be deleted. Please try again.')
  }
  if (!count) {
    // Gone already, most likely deleted on the other phone: what was asked for is done, so there is
    // nothing to try again. GoalsList reloads on a 404.
    console.error('[goals] delete matched no rows (goal already deleted, or the delete policy is missing)', { id })
    return fail(404, 'That goal was already deleted.')
  }
  return NextResponse.json({ ok: true })
}
