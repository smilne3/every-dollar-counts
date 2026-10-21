import { NextResponse } from 'next/server'
import { isAuthRetryableFetchError } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { isCardPaymentRow, CREDIT_CARD_PAYMENT_DETAILED, type Category } from '@/lib/categories'
import { buildKindContext, learnableRule } from '@/lib/category-rules'
import { assertEnvMatchesDatabase, EnvMismatchError } from '@/lib/app-env'
import { unknownIfLost } from '@/lib/lost-reply'

// Sets the category on ONE transaction (#28 spec §6.1). Runs as the user, so RLS decides WHOSE rows;
// the guards below decide WHICH writes are coherent. Every message here may be shown to a person
// verbatim (CategoryPicker does), so none carries the database's words; those go to the log.
//
// Then, if the merchant has no rule yet and the pick passes learnableRule (same kind, and not the
// bank's own category), it teaches a household rule (§6.1 step 8) that files the merchant's unpicked
// rows the same way at read time. Learning never writes transactions, and a failed learn never fails
// the pick.
//
// What it will not do:
// - clear a pick (spec decision 7), or write a name that is not one of the household's categories
//   (including the display fallback 'Uncategorized'): no UI sends either, and a name that is not a
//   real category would become its own spending bucket;
// - touch a card payment, picked or not (#59). On an unpicked one, any user_category re-enters it
//   into every total. An already-picked one stays refused too: changing it can move it between
//   spending and income, and a pick cannot be cleared back to the exclusion (spec decision 7). The
//   test is pfc_detailed alone, because isCreditCardPayment turns false once a pick is set;
// - write a row the bank removed.
//
// It is not the only writer of user_category: app/api/categories/route.ts also writes it in bulk on
// rename and delete (a delete clears picks), outside these guards (#100).
const SAVE_FAILED = 'That could not be saved. Please try again.'

export async function POST(req: Request) {
  // 1. Validate before touching the database.
  const body = (await req.json().catch(() => null)) as { transactionId?: unknown; category?: unknown } | null
  const transactionId = typeof body?.transactionId === 'string' ? body.transactionId : ''
  const category = typeof body?.category === 'string' ? body.category.trim() : ''
  if (!transactionId || !category) {
    return NextResponse.json({ error: 'Choose a category for this transaction.' }, { status: 400 })
  }

  // 2. Sign-in. proxy.ts usually redirects a signed-out /api call first; this stays as defence.
  //    getUser answers `user: null` with an error on ANY auth failure. Only a transport failure
  //    (Supabase Auth unreachable, or a 5xx from it) leaves the session's state unknown, and
  //    for that alone the answer is "try again". Every other auth error means the session has ended:
  //    a missing session, but also a dead refresh token on an expired one, which comes back as the
  //    refresh call's own 4xx (refresh_token_not_found, refresh_token_already_used,
  //    session_expired). "Try again" there would never succeed.
  const supabase = await createClient()
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()
  if (isAuthRetryableFetchError(authError)) {
    console.error('[categorize] auth check failed', authError.message)
    return NextResponse.json({ error: SAVE_FAILED }, { status: 503 })
  }
  if (!user) return NextResponse.json({ error: 'Your session ended. Sign in again.' }, { status: 401 })

  // 3. Read the row. merchant_name and pfc_primary are for learning (step 8).
  const { data: row, error: readError } = await supabase
    .from('transactions')
    .select('id, household_id, merchant_name, pfc_primary, pfc_detailed, removed, user_category')
    .eq('id', transactionId)
    .maybeSingle()
  // Fail closed: a read error must not pass for "no such transaction" or fall through to the write.
  if (readError) {
    console.error('[categorize] transaction read failed', readError.message)
    return NextResponse.json({ error: SAVE_FAILED }, { status: 500 })
  }
  if (!row) {
    return NextResponse.json({ error: 'That transaction no longer exists. Refresh and try again.' }, { status: 404 })
  }
  if (row.removed) {
    return NextResponse.json(
      { error: 'Your bank removed that transaction. Refresh and try again.' },
      { status: 400 }
    )
  }

  // 4. Card payments, picked or not.
  if (isCardPaymentRow(row.pfc_detailed)) {
    return NextResponse.json(
      { error: 'A credit-card payment is already kept out of spending and income.' },
      { status: 400 }
    )
  }

  // 5. The row's household's categories, whole and in order. Learning (§6.1 step 8) builds its kind
  //    gate from this list, which must never be partial.
  const { data: cats, error: catsError } = await supabase
    .from('categories')
    .select('id, name, pfc_primary, sort_order')
    .eq('household_id', row.household_id)
    .order('sort_order')
  if (catsError) {
    console.error('[categorize] categories read failed', catsError.message)
    return NextResponse.json({ error: SAVE_FAILED }, { status: 500 })
  }
  const picked = (cats ?? []).find((c) => c.name === category)
  if (!picked) {
    return NextResponse.json(
      { error: 'That category no longer exists. Refresh and try again.' },
      { status: 400 }
    )
  }

  // 6. Write, with the guards INSIDE the update, so Plaid re-tagging or removing the row between the
  //    read and the write cannot slip through. The .or is deliberate: .neq alone would silently skip
  //    rows whose pfc_detailed is null. `count` is what tells "wrote it" from "matched nothing";
  //    without it a write that matches no row reads as success, the way the households update
  //    policy that silently matched nothing went unseen (#73; see app/api/household/timezone/route.ts).
  const { error, count, status } = await supabase
    .from('transactions')
    .update({ user_category: picked.name }, { count: 'exact' })
    .eq('id', transactionId)
    .eq('removed', false)
    .or(`pfc_detailed.is.null,pfc_detailed.neq.${CREDIT_CARD_PAYMENT_DETAILED}`)
  if (error) {
    console.error('[categorize] update failed', error.message)
    // A pick the database never answered may have landed, so its outcome is unknown
    // (lib/lost-reply.ts). Nothing is learned from it: only a saved pick can teach (step 8).
    return unknownIfLost(status, error) ?? NextResponse.json({ error: SAVE_FAILED }, { status: 500 })
  }
  if (!count) {
    // Usually the row changed underneath us. A missing update policy would also land here, which is
    // why the log says both.
    console.error('[categorize] update matched no rows (row changed, or the update policy is missing)', transactionId)
    return NextResponse.json({ error: 'This transaction just changed. Refresh and try again.' }, { status: 409 })
  }

  // 7. A record of every change, so a mistaken pick can be put back from the logs.
  console.info('[categorize] changed', { id: transactionId, from: row.user_category, to: picked.name })

  // 8. Learn. After the write, so only a saved pick can teach.
  const learned = await learn(supabase, row, picked, cats ?? [])

  // 9. `learned` is for tests and logs; the UI shows nothing (spec decision 1).
  return NextResponse.json({ ok: true, learned })
}

type Learned = 'created' | 'exists' | 'no' | 'skipped' | 'failed'

// Spec §6.1 step 8. Never throws: the pick is already saved, and a learn that fails must not turn
// it into an error the picker would roll back.
async function learn(
  supabase: Awaited<ReturnType<typeof createClient>>,
  row: { household_id: string; merchant_name: string | null; pfc_primary: string | null; pfc_detailed: string | null },
  picked: Category,
  cats: Category[]
): Promise<Learned> {
  let rule: ReturnType<typeof learnableRule>
  try {
    rule = learnableRule(row, picked.name, buildKindContext(cats))
  } catch (e) {
    // No merchant_key: the gate computes it, and it is what just threw.
    console.error('[categorize] learn failed', { household_id: row.household_id }, e)
    return 'failed'
  }
  if (!rule) return 'no'
  const context = { household_id: row.household_id, merchant_key: rule.merchantKey }

  // Local and Preview run sandbox against the shared database, and must not create rules that
  // production then applies.
  try {
    await assertEnvMatchesDatabase()
  } catch (e) {
    if (e instanceof EnvMismatchError) {
      console.warn('[categorize] learn skipped: environment', e.message)
      return 'skipped'
    }
    console.error('[categorize] learn failed', context, e)
    return 'failed'
  }

  // INSERT … ON CONFLICT DO NOTHING RETURNING id: a row back means this pick created the rule. None
  // means the merchant already has one, so this pick stays a one-row exception (decision 3). The
  // unique (household_id, merchant_key) gives two partners' simultaneous first picks one rule.
  try {
    const { data, error } = await supabase
      .from('category_rules')
      .upsert(
        {
          household_id: row.household_id,
          merchant_key: rule.merchantKey,
          merchant_label: rule.merchantLabel,
          category_id: picked.id,
          origin: 'learned',
        },
        { onConflict: 'household_id,merchant_key', ignoreDuplicates: true }
      )
      .select('id')
    if (error) {
      // 23503 here is the category deleted between the read and the insert. One whose reply was
      // lost (lib/lost-reply.ts) may have made the rule, and still reads 'failed': the pick is saved
      // either way, nothing here reaches the person, and the merchant's next pick finds the rule if
      // it was made.
      console.error('[categorize] learn failed', {
        ...context,
        code: error.code,
        message: error.message,
        details: error.details,
      })
      return 'failed'
    }
    if (!data?.length) {
      console.info('[categorize] learn: rule exists', { merchant_key: rule.merchantKey })
      return 'exists'
    }
    console.info('[categorize] learned', { merchant_key: rule.merchantKey, category: picked.name, rule: data[0].id })
    return 'created'
  } catch (e) {
    console.error('[categorize] learn failed', context, e)
    return 'failed'
  }
}
