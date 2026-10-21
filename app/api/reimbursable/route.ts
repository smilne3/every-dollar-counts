import { NextResponse } from 'next/server'
import { isAuthRetryableFetchError } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { clampReimbursable } from '@/lib/reimbursements'
import { isCreditCardPayment } from '@/lib/categories'
import { unknownIfLost } from '@/lib/lost-reply'

// Mark how much of a transaction is coming back, or clear the mark. One route, one column — there is
// no claim to create, no person to name, and no second row to keep in step with this one.
//
// Every message here may be shown verbatim (ReimbursableCheckbox and ReimbursableEditor do), so none
// carries the database's words; those go to the log.
const TRY_AGAIN = 'That could not be saved. Please try again.'
const fail = (status: number, error: string) => NextResponse.json({ error }, { status })

export async function PATCH(req: Request) {
  const body = (await req.json().catch(() => null)) as { transactionId?: unknown; amount?: unknown; note?: unknown } | null
  const transactionId = typeof body?.transactionId === 'string' ? body.transactionId : ''
  // No editor sends a save without one; a request that does has nothing to save.
  if (!transactionId) return fail(400, 'That could not be saved. Refresh and try again.')
  const amount = body?.amount
  const note = body?.note

  const supabase = await createClient()

  // RLS already scopes the select/update below to this household (db/migrations/006_rls_policies.sql),
  // so an unauthenticated caller cannot read or write another household's row. This check exists for
  // two reasons anyway: it is the only thing standing between a money-mutating endpoint and relying on
  // RLS ALONE, and it keeps the response honest — without it an unauthenticated caller gets a
  // misleading "no longer exists" instead of the 401 every sibling mutating route returns. Only an
  // unreachable Supabase Auth leaves the session's state unknown (see the categorize route).
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()
  if (isAuthRetryableFetchError(authError)) {
    console.error('[reimbursable] auth check failed', { code: authError.code, message: authError.message })
    return fail(503, TRY_AGAIN)
  }
  if (!user) return fail(401, 'Your session ended. Sign in again.')

  const { data: txn, error: readError } = await supabase
    .from('transactions')
    // pfc_detailed and user_category are here only to evaluate isCreditCardPayment below.
    .select('id, amount, removed, pfc_detailed, user_category')
    .eq('id', transactionId)
    .maybeSingle()
  // Fail closed: a read error must not be mistaken for "no such transaction".
  if (readError) {
    console.error('[reimbursable] transaction read failed', { id: transactionId, code: readError.code, message: readError.message })
    return fail(500, TRY_AGAIN)
  }
  if (!txn) return fail(404, 'That transaction no longer exists. Refresh and try again.')

  // `removed` is a soft flag (a Plaid repost), not a delete, so nothing stops a mark being written
  // to a row that no longer renders anywhere. That mark would then be unreachable while still
  // counting toward what you are owed.
  if (txn.removed) return fail(400, 'Your bank removed that transaction. Refresh and try again.')

  // Guards #31. A credit-card payment is already excluded from both spending and income — the
  // purchases were counted when they happened — so marking it reduces nothing while still inflating
  // what you are owed. Refuse at the source rather than relying on every reader to filter it out.
  if (isCreditCardPayment(txn)) return fail(400, 'A credit-card payment is already kept out of spending and income.')

  // The guards above ran on the row as it was read. The write checks them again: it applies only
  // while the row is still not removed and still has the pfc_detailed and user_category that were
  // read, so a Plaid sync that removes or re-tags it, or a pick made or cleared on the other phone,
  // in between matches nothing, as in the categorize route. A null is matched with .is: .eq with
  // null is not "is null" in PostgREST. The amount needs no filter, since the database's own CHECK
  // refuses a mark above the charge (db/migrations/015_reimbursable_amount.sql).
  //
  // `count` is what tells "wrote it" from "matched nothing". Without it a write that matched no row
  // (the row changed in between, or the update policy went missing, as in #73) read as saved.
  let write = supabase
    .from('transactions')
    .update(
      {
        reimbursable_amount: clampReimbursable(amount === null ? null : Number(amount), Number(txn.amount)),
        reimbursable_note: (typeof note === 'string' ? note.trim() : '') || null,
      },
      { count: 'exact' }
    )
    .eq('id', transactionId)
    .eq('removed', false)
  write = txn.pfc_detailed === null ? write.is('pfc_detailed', null) : write.eq('pfc_detailed', txn.pfc_detailed)
  write = txn.user_category === null ? write.is('user_category', null) : write.eq('user_category', txn.user_category)
  const { error, count, status } = await write
  if (error) {
    console.error('[reimbursable] update failed', { id: transactionId, code: error.code, message: error.message })
    // A mark the database never answered may have been written, so its outcome is unknown
    // (lib/lost-reply.ts): the editors say so and reload.
    return unknownIfLost(status) ?? fail(500, TRY_AGAIN)
  }
  if (!count) {
    // A stale-card refusal: the editors reload on a 409 to show the latest.
    console.error('[reimbursable] update matched no rows (row changed, or the update policy is missing)', { id: transactionId })
    return fail(409, 'This transaction just changed. Refresh and try again.')
  }

  return NextResponse.json({ ok: true })
}
