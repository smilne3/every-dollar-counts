import { NextResponse } from 'next/server'
import { isAuthRetryableFetchError } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'

// Budgets → Save budgets (BudgetEditor): one bulk save. A category with a limit above zero is
// upserted for the caller's household; one set to 0 or left blank has its limit deleted. Every
// message here may be shown verbatim (BudgetEditor does), so none carries the database's words;
// those go to the log. The pages read budgets straight from the table, so there is no GET.
const TRY_AGAIN = 'That could not be saved. Please try again.'
const fail = (status: number, error: string) => NextResponse.json({ error }, { status })

type Item = { category: string; monthly_limit: unknown }
const isItem = (it: unknown): it is Item =>
  typeof (it as Item | null)?.category === 'string' && (it as Item).category !== ''

export async function POST(req: Request) {
  // 1. Validate before touching the database. BudgetEditor always sends every category; a request
  //    that does not has nothing to save.
  const body = (await req.json().catch(() => null)) as { items?: unknown } | null
  const items = body?.items
  if (!Array.isArray(items) || !items.every(isItem)) {
    return fail(400, 'That could not be saved. Refresh and try again.')
  }

  // 2. Sign-in and household, as app/api/category-rules/route.ts: 503 if Supabase Auth is
  //    unreachable, 401; 500 if the membership read fails, 403.
  const supabase = await createClient()
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()
  // Only an unreachable Supabase Auth leaves the session's state unknown; see the categorize route.
  if (isAuthRetryableFetchError(authError)) {
    console.error('[budgets] auth check failed', { code: authError.code, message: authError.message })
    return fail(503, TRY_AGAIN)
  }
  if (!user) return fail(401, 'Your session ended. Sign in again.')
  const { data: m, error: mError } = await supabase.from('memberships').select('household_id').limit(1).maybeSingle()
  // A failed read is not "no household" (#162).
  if (mError) {
    console.error('[budgets] membership read failed', { code: mError.code, message: mError.message })
    return fail(500, TRY_AGAIN)
  }
  if (!m) return fail(403, "Your account isn't part of a household.")
  const household_id = m.household_id as string

  const toUpsert: { household_id: string; category: string; monthly_limit: number }[] = []
  const toDelete: string[] = []
  for (const it of items) {
    const limit = Number(it.monthly_limit)
    if (limit > 0) toUpsert.push({ household_id, category: it.category, monthly_limit: limit })
    else toDelete.push(it.category)
  }

  // 3. Write. The upsert goes first, so if it fails nothing has been written.
  if (toUpsert.length) {
    const { error } = await supabase.from('budgets').upsert(toUpsert, { onConflict: 'household_id,category' })
    if (error) {
      console.error('[budgets] upsert failed', { household_id, code: error.code, message: error.message })
      return fail(500, TRY_AGAIN)
    }
  }
  // Scoped to the household the upsert wrote to, not left to RLS alone. If this fails, the limits
  // above zero have already saved, so the message names the part that did not (#162).
  if (toDelete.length) {
    const { error } = await supabase.from('budgets').delete().eq('household_id', household_id).in('category', toDelete)
    if (error) {
      console.error('[budgets] delete failed', { household_id, code: error.code, message: error.message })
      return fail(500, 'The limits you cleared could not be removed. Please try again.')
    }
  }
  return NextResponse.json({ ok: true })
}
