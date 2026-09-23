import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isCreditCardPayment } from '@/lib/categories'

// Re-categorize a transaction. Runs as the user, so RLS ("update your txns")
// enforces that they can only touch their own household's rows.
//
// RLS is about WHOSE rows; the guards below are about WHICH writes are coherent at all. This is the
// only route that sets an arbitrary override on a SINGLE transaction, so anything not refused here
// lands in the totals. It is not the only writer of the column: app/api/categories/route.ts rewrites
// it in bulk when a category is renamed (:67) or deleted (:87), and the rename cascade does no
// validation of its own — so the guarantees below stop at this door.
export async function POST(req: Request) {
  const { transactionId, category } = await req.json()
  if (!transactionId) {
    return NextResponse.json({ error: 'transactionId required' }, { status: 400 })
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: txn, error: readError } = await supabase
    .from('transactions')
    // pfc_detailed and user_category are here only to evaluate isCreditCardPayment below.
    .select('id, pfc_detailed, user_category')
    .eq('id', transactionId)
    .maybeSingle()
  // Fail closed: a read error must not be mistaken for "no such transaction", and must never fall
  // through to the write.
  if (readError) {
    return NextResponse.json({ error: 'could not read the transaction' }, { status: 500 })
  }
  if (!txn) return NextResponse.json({ error: 'transaction not found' }, { status: 404 })

  // Guards #98. isCreditCardPayment is `!user_category && pfc_detailed === CREDIT_CARD_PAYMENT`, so
  // writing ANY override here permanently flips it false and re-enters the leg you categorized into
  // the totals. (A card payment is stored as two rows — money out of checking, money into the card —
  // and both are excluded; one POST re-admits one of them.) Measured on a real row: categorizing the
  // card-side leg as spending moved September spending from $3,949.16 to -$3,917.53, the inflow
  // landing in `bucket.spending` at lib/dashboard.ts:117-120; categorizing it as Income invented
  // $7,866.69 of income. Both UI surfaces already refuse this, but the mobile pass keeps adding
  // surfaces and each one had to remember independently. Refuse at the source.
  //
  // Only an AUTO-categorized payment is refused: the override-wins contract in lib/categories.ts is
  // deliberate, so a row a human has already ruled on stays correctable rather than frozen.
  if (isCreditCardPayment(txn)) {
    return NextResponse.json(
      { error: 'a credit-card payment moves money between your own accounts' },
      { status: 400 }
    )
  }

  // 'Uncategorized' is effectiveCategory's DISPLAY fallback, never a row in `categories` — but
  // CategoryPicker deliberately offers it whenever it is the current value. Validating it like a
  // real name would reject an option the UI itself presents; writing it literally would create the
  // phantom bucket described below. Choosing it means "no override", same as clearing.
  const requested = typeof category === 'string' ? category.trim() : ''
  const next = requested && requested !== 'Uncategorized' ? requested : null

  // effectiveCategory returns user_category verbatim, so an unvalidated string silently becomes its
  // own spending bucket: absent from nonSpendingNames AND transferNames, it counts as real
  // spending under a name nothing else in the app knows about.
  if (next) {
    const { data: cats, error: catsError } = await supabase.from('categories').select('name')
    // Fail closed again — an empty list from a failed read would reject every valid category.
    if (catsError) {
      return NextResponse.json({ error: 'could not read your categories' }, { status: 500 })
    }
    if (!(cats ?? []).some((c) => c.name === next)) {
      return NextResponse.json({ error: 'that is not one of your categories' }, { status: 400 })
    }
  }

  // `count` is the point of this call, not decoration. Supabase sends no count header by default and
  // reports `error: null` for an update that matched NOTHING, so without it "wrote the row" and
  // "wrote nothing" are the same answer. That is how #73 hid: households had no update policy, the
  // write matched zero rows, the route said ok, and the old value came back forever.
  // app/api/household/timezone/route.ts:26-42 is the precedent this mirrors.
  const { error, count } = await supabase
    .from('transactions')
    .update({ user_category: next }, { count: 'exact' })
    .eq('id', transactionId)

  // Log the database's words, do not SHOW them — the rule app/api/manual-assets/route.ts:47-53
  // already states. CategoryPicker now renders whatever this route returns, so echoing
  // `error.message` would put raw Postgres ("new row violates row-level security policy...") in a
  // red span on someone's phone. 500, not 400: a failed write is a server fault, not a refusal the
  // user can act on, and the two guards above own the 400s that are worth reading.
  if (error) {
    console.error('[categorize] update failed', error.message)
    return NextResponse.json({ error: 'That could not be saved. Please try again.' }, { status: 500 })
  }
  if (!count) {
    console.error('[categorize] update matched no rows — is the update policy present?')
    return NextResponse.json({ error: 'That could not be saved. Please try again.' }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
