import { NextResponse } from 'next/server'
import { isAuthRetryableFetchError } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { assertEnvMatchesDatabase, envGuardResponse } from '@/lib/app-env'
import { buildKindContext, kindOf } from '@/lib/category-rules'

// Settings → Category rules: Change (PATCH) and Remove (DELETE). #28 spec §6.2. No POST: creating a
// rule from scratch is out of scope; rules come from the seed and, from PR 3, from a first pick.
//
// The client always sends the category it was SHOWING (`expectedCategoryId`), and every write is
// filtered on it, so an action applies only to the rule the person saw. Every message may be shown
// verbatim (CategoryRulesCard does); the database's words go to the log.
//
// Environment-guarded: one database serves local, Preview and production, and a rule written from
// a sandbox session would relabel production's transactions.
const TRY_AGAIN = 'That could not be saved. Please try again.'
const RULE_CHANGED = 'This rule just changed. Refresh and try again.'
const ENV_MESSAGES = {
  tag: '[category-rules]',
  mismatch: 'This app is pointed at a database from a different environment. Nothing saved.',
  unreadable: 'Could not verify which database this is, so nothing was saved.',
}

type Supabase = Awaited<ReturnType<typeof createClient>>
const fail = (status: number, error: string) => NextResponse.json({ error }, { status })
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

// Sign-in, household and environment, in that order (401, 403, then the guard's 409/500).
async function authorize(): Promise<{ supabase: Supabase; householdId: string } | NextResponse> {
  const supabase = await createClient()
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()
  // Only an unreachable Supabase Auth leaves the session's state unknown; see the categorize route.
  if (isAuthRetryableFetchError(authError)) {
    console.error('[category-rules] auth check failed', { code: authError.code, message: authError.message })
    return fail(503, TRY_AGAIN)
  }
  if (!user) return fail(401, 'Your session ended. Sign in again.')
  const { data: m, error: mError } = await supabase.from('memberships').select('household_id').limit(1).maybeSingle()
  if (mError) {
    console.error('[category-rules] membership read failed', { code: mError.code, message: mError.message })
    return fail(500, TRY_AGAIN)
  }
  if (!m) return fail(403, "Your account isn't part of a household.")
  try {
    await assertEnvMatchesDatabase()
  } catch (e) {
    return envGuardResponse(e, ENV_MESSAGES)
  }
  return { supabase, householdId: m.household_id as string }
}

// Change: move a rule to another category of the SAME kind (spending, transfer or income), so a
// rule never moves money between Spent, Income and Saved.
export async function PATCH(req: Request) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
  const id = text(body?.id)
  const categoryId = text(body?.categoryId)
  const expectedCategoryId = text(body?.expectedCategoryId)
  if (!id || !categoryId || !expectedCategoryId) return fail(400, 'Choose a category for this rule.')

  const auth = await authorize()
  if (auth instanceof NextResponse) return auth
  const { supabase, householdId } = auth

  const { data: rule, error: ruleError } = await supabase
    .from('category_rules')
    .select('id, category_id')
    .eq('id', id)
    .eq('household_id', householdId)
    .maybeSingle()
  if (ruleError) {
    console.error('[category-rules] rule read failed', { id, code: ruleError.code, message: ruleError.message })
    return fail(500, TRY_AGAIN)
  }
  if (!rule) return fail(404, 'That rule no longer exists. Refresh and try again.')
  if (rule.category_id !== expectedCategoryId) return fail(409, RULE_CHANGED)

  const { data: cats, error: catsError } = await supabase
    .from('categories')
    .select('id, name, pfc_primary, sort_order')
    .eq('household_id', householdId)
    .order('sort_order')
  if (catsError) {
    console.error('[category-rules] categories read failed', { id, code: catsError.code, message: catsError.message })
    return fail(500, TRY_AGAIN)
  }
  // Neither data nor error is a failed read: as "no categories" it would refuse the Change as stale.
  if (!cats) {
    console.error('[category-rules] categories read returned no data', { id })
    return fail(500, TRY_AGAIN)
  }
  const categories = cats
  const current = categories.find((c) => c.id === expectedCategoryId)
  if (!current) return fail(409, RULE_CHANGED) // deleted between the two reads
  const target = categories.find((c) => c.id === categoryId)
  if (!target) return fail(400, 'That category no longer exists. Refresh and try again.')
  const k = buildKindContext(categories)
  if (kindOf(target.name, k) !== kindOf(current.name, k)) {
    return fail(400, 'A rule can only move to a category that counts the same way.')
  }
  if (categoryId === expectedCategoryId) return NextResponse.json({ ok: true })

  // No update trigger on this table (precedent: app/api/manual-assets/route.ts), so updated_at is
  // set here. Filtered on the category the client saw, so a concurrent Change cannot be overwritten.
  const { error, count } = await supabase
    .from('category_rules')
    .update({ category_id: categoryId, updated_at: new Date().toISOString() }, { count: 'exact' })
    .eq('id', id)
    .eq('category_id', expectedCategoryId)
  if (error?.code === '23503') {
    // The target category was deleted between our read and this write.
    console.error('[category-rules] change hit a deleted category', { id, code: error.code, message: error.message })
    return fail(409, RULE_CHANGED)
  }
  if (error) {
    console.error('[category-rules] change failed', { id, code: error.code, message: error.message })
    return fail(500, TRY_AGAIN)
  }
  if (!count) return fail(409, RULE_CHANGED)
  console.log('[category-rules] changed', { id, from: current.name, to: target.name })
  return NextResponse.json({ ok: true })
}

// Remove: forget the rule (spec decision 6). Its rows go back to their bank category, hand picks
// keep theirs, and the merchant's next pick teaches again (from PR 3).
export async function DELETE(req: Request) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
  const id = text(body?.id)
  const expectedCategoryId = text(body?.expectedCategoryId)
  if (!id || !expectedCategoryId) return fail(400, 'That rule could not be removed. Refresh and try again.')

  const auth = await authorize()
  if (auth instanceof NextResponse) return auth
  const { supabase } = auth

  const { error, count } = await supabase
    .from('category_rules')
    .delete({ count: 'exact' })
    .eq('id', id)
    .eq('category_id', expectedCategoryId)
  if (error) {
    console.error('[category-rules] remove failed', { id, code: error.code, message: error.message })
    return fail(500, TRY_AGAIN)
  }
  if (!count) return fail(409, RULE_CHANGED)
  console.log('[category-rules] removed', { id, categoryId: expectedCategoryId })
  return NextResponse.json({ ok: true })
}
