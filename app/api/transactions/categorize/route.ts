import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isCardPaymentRow, CREDIT_CARD_PAYMENT_DETAILED } from '@/lib/categories'

// Sets the category on ONE transaction (#28 spec §6.1). Runs as the user, so RLS decides WHOSE rows;
// the guards below decide WHICH writes are coherent. Every message here may be shown to a person
// verbatim (CategoryPicker does), so none carries the database's words; those go to the log.
//
// What it will not do:
// - clear a pick, or write 'Uncategorized' (spec decision 7): no UI sends either, and a name that is
//   not a real category would become its own spending bucket;
// - touch a card payment, picked or not (#59): any user_category on one re-enters it into every
//   total. The test is pfc_detailed alone, because isCreditCardPayment turns false once a pick is set;
// - write a row the bank removed.
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
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Your session ended. Sign in again.' }, { status: 401 })

  // 3. Read the row. Every column here is used below, or by learning in PR 3.
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

  // 5. The row's household's categories, whole and in order: PR 3 builds its kind gate from this
  //    list, which must never be partial.
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
  //    rows whose pfc_detailed is null. `count` is what tells "wrote it" from "matched nothing" (#73).
  const { error, count } = await supabase
    .from('transactions')
    .update({ user_category: picked.name }, { count: 'exact' })
    .eq('id', transactionId)
    .eq('removed', false)
    .or(`pfc_detailed.is.null,pfc_detailed.neq.${CREDIT_CARD_PAYMENT_DETAILED}`)
  if (error) {
    console.error('[categorize] update failed', error.message)
    return NextResponse.json({ error: SAVE_FAILED }, { status: 500 })
  }
  if (!count) {
    // Usually the row changed underneath us. A missing update policy would also land here, which is
    // why the log says both.
    console.error('[categorize] update matched no rows (row changed, or the update policy is missing)', transactionId)
    return NextResponse.json({ error: 'This transaction just changed. Refresh and try again.' }, { status: 409 })
  }

  // 7. A record of every change, so a mistaken pick can be put back from the logs.
  console.info('[categorize] changed', { id: transactionId, from: row.user_category, to: picked.name })

  // 9. PR 3 adds `learned` here.
  return NextResponse.json({ ok: true })
}
