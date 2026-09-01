import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { clampReimbursable } from '@/lib/reimbursements'
import { isCreditCardPayment } from '@/lib/categories'

// Mark how much of a transaction is coming back, or clear the mark. One route, one column — there is
// no claim to create, no person to name, and no second row to keep in step with this one.
export async function PATCH(req: Request) {
  const { transactionId, amount, note } = await req.json()
  if (!transactionId) {
    return NextResponse.json({ error: 'transactionId required' }, { status: 400 })
  }

  const supabase = await createClient()

  // RLS already scopes the select/update below to this household (db/migrations/006_rls_policies.sql),
  // so an unauthenticated caller cannot read or write another household's row. This check exists for
  // two reasons anyway: it is the only thing standing between a money-mutating endpoint and relying on
  // RLS ALONE, and it keeps the response honest — without it an unauthenticated caller gets a
  // misleading "transaction not found" instead of the 401 every sibling mutating route returns.
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: txn, error: readError } = await supabase
    .from('transactions')
    // pfc_detailed and user_category are here only to evaluate isCreditCardPayment below.
    .select('id, amount, removed, pfc_detailed, user_category')
    .eq('id', transactionId)
    .maybeSingle()
  // Fail closed: a read error must not be mistaken for "no such transaction".
  if (readError) return NextResponse.json({ error: 'could not read the transaction' }, { status: 500 })
  if (!txn) return NextResponse.json({ error: 'transaction not found' }, { status: 404 })

  // `removed` is a soft flag (a Plaid repost), not a delete, so nothing stops a mark being written
  // to a row that no longer renders anywhere. That mark would then be unreachable while still
  // counting toward what you are owed.
  if (txn.removed) {
    return NextResponse.json({ error: 'that transaction was removed' }, { status: 400 })
  }

  // Guards #31. A credit-card payment is already excluded from both spending and income — the
  // purchases were counted when they happened — so marking it reduces nothing while still inflating
  // what you are owed. Refuse at the source rather than relying on every reader to filter it out.
  if (isCreditCardPayment(txn)) {
    return NextResponse.json(
      { error: 'a credit-card payment is already excluded from spending' },
      { status: 400 }
    )
  }

  const { error } = await supabase
    .from('transactions')
    .update({
      reimbursable_amount: clampReimbursable(amount === null ? null : Number(amount), Number(txn.amount)),
      reimbursable_note: (note ?? '').trim() || null,
    })
    .eq('id', transactionId)
  if (error) return NextResponse.json({ error: error.message }, { status: 400 })

  return NextResponse.json({ ok: true })
}
