import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { pfcToName, type Category } from '@/lib/categories'
import { effectiveCategory } from '@/lib/effective-category'
import {
  claimTotals,
  allocateWriteOff,
  type Claim,
  type Split,
} from '@/lib/reimbursements'

async function household(supabase: Awaited<ReturnType<typeof createClient>>) {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return null
  const { data: m } = await supabase.from('memberships').select('household_id').limit(1).single()
  return m?.household_id ?? null
}

// Every claim with its totals and per-person breakdown. RLS scopes all three reads to the household.
export async function GET() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: claims } = await supabase
    .from('reimbursement_claims')
    .select('id, name, written_off_on, pinned')
    .order('created_at', { ascending: false })
  const { data: splits } = await supabase
    .from('reimbursement_splits')
    .select('transaction_id, claim_id, owed_by, amount')

  const all = (splits ?? []) as Split[]
  // BOUNDED to the transactions the splits actually reference. Reading the whole transactions
  // table here is not merely wasteful, it is WRONG: PostgREST caps a select at the project's
  // max-rows setting (1000 by default) and truncates SILENTLY, so past that many transactions the
  // page no longer covers the split rows, claimTotals' txnAmount-undefined guard drops every split
  // whose transaction fell outside it, and a live $750 claim reports $0 owed / Settled while the
  // dashboard — which has always looked ids up this way — still reports $750.
  // The sentinel id keeps the list non-empty: PostgREST rejects an empty `in.()` rather than
  // treating it as "matches nothing".
  const txnIds = [...new Set(all.map((s) => s.transaction_id))]
  // Excluding removed rows is what lets claimTotals recompute "from what remains": a removed
  // transaction's splits fall out of amountById, so claimTotals' txnAmount-undefined guard skips
  // them instead of counting an unreachable split as still-owed money.
  const { data: txns } = await supabase
    .from('transactions')
    .select('id, amount')
    .eq('removed', false)
    .in('id', txnIds.length ? txnIds : ['00000000-0000-0000-0000-000000000000'])

  const amountById: Record<string, number> = {}
  for (const t of txns ?? []) amountById[t.id as string] = Number(t.amount)

  const withTotals = ((claims ?? []) as Claim[]).map((c) => ({
    ...c,
    totals: claimTotals(
      c,
      all.filter((s) => s.claim_id === c.id),
      amountById
    ),
  }))
  return NextResponse.json({ claims: withTotals })
}

// Create a claim (called inline the first time a name is typed in the split editor), or write one
// off. Both are POST so the split editor can create-and-use in a single round trip.
export async function POST(req: Request) {
  const body = await req.json()
  const supabase = await createClient()
  const hid = await household(supabase)
  if (!hid) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  // Note what is NOT forwarded: a caller-supplied date. See writeOff.
  if (body.action === 'write_off') {
    return writeOff(supabase, hid, body.id)
  }

  const name = (body.name ?? '').trim()
  if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 })

  // Idempotent on name: typing an existing claim's name in the editor reuses it rather than failing
  // on the unique constraint.
  const { data: existing } = await supabase
    .from('reimbursement_claims')
    .select('id')
    .eq('name', name)
    .maybeSingle()
  if (existing) return NextResponse.json({ id: existing.id })

  const { data, error } = await supabase
    .from('reimbursement_claims')
    .insert({ household_id: hid, name })
    .select('id')
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 400 })
  return NextResponse.json({ id: data.id })
}

// Giving up on a claim turns the unreturned amount into real spending, dated TODAY (not the original
// expense month — no closed month may change), allocated across the categories it came from and then
// frozen as rows.
//
// The write-off date is ALWAYS today and is never taken from the request. There is deliberately no
// `onDate` parameter: this function is the one place that writes into the frozen ledger, and a
// caller-supplied date would let anyone POST {"action":"write_off","onDate":"2019-03-01"} and drop
// spending into an already-closed month — the retroactive rewrite the whole feature exists to
// prevent. (Defaulting with `?? today` would not have helped either: `??` passes an empty string
// straight through.) The UI has never sent the field.
//
// This function is also the ONLY caller of allocateWriteOff; no read path may reach it, because
// allocating on read would recompute a frozen month every time someone looked at it.
async function writeOff(
  supabase: Awaited<ReturnType<typeof createClient>>,
  hid: string,
  id: string
) {
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  // maybeSingle, not single: `single` reports "no rows" AS an error, which would make the
  // fail-closed error check below answer 500 for a claim that simply does not exist. With
  // maybeSingle, a missing row is `data: null, error: null` and stays a clean 404.
  const { data: claim, error: claimError } = await supabase
    .from('reimbursement_claims')
    .select('id, name, written_off_on')
    .eq('id', id)
    .maybeSingle()
  if (claimError) {
    return NextResponse.json({ error: 'could not read the claim' }, { status: 500 })
  }
  if (!claim) return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (claim.written_off_on) {
    return NextResponse.json({ error: 'already written off' }, { status: 400 })
  }

  // EVERY read below is checked. A write-off is irreversible — DELETE refuses a written-off claim
  // and there is no un-write-off — so proceeding on a failed read would freeze the wrong numbers
  // (or, worse, no numbers at all) with no way back. Fail closed and let the user retry.
  const { data: splits, error: splitsError } = await supabase
    .from('reimbursement_splits')
    .select('transaction_id, claim_id, owed_by, amount')
    .eq('claim_id', id)
  if (splitsError) {
    return NextResponse.json({ error: 'could not read the claim’s splits' }, { status: 500 })
  }
  // Categories decide which category each frozen row is filed under: without them effectiveCategory
  // falls back to 'Uncategorized' for every Plaid-categorized expense, so a failed read here would
  // silently misfile real spending rather than lose it.
  const { data: cats, error: catsError } = await supabase
    .from('categories')
    .select('id, name, pfc_primary, sort_order')
  if (catsError) {
    return NextResponse.json({ error: 'could not read categories' }, { status: 500 })
  }
  const pfcMap = pfcToName((cats ?? []) as Category[])

  const splitList = (splits ?? []) as Split[]
  const ids = [...new Set(splitList.map((s) => s.transaction_id))]
  // `removed` MUST be excluded here specifically: a Plaid repost soft-deletes the original row
  // (`removed = true`) without ever deleting it, so the FK cascade on reimbursement_splits never
  // fires and the split survives, unreachable, on a transaction that renders nowhere in the app. If
  // this lookup counted that transaction's amount, allocateWriteOff would treat its split as still
  // outstanding and freeze real spending — dated today — for money that never actually left the
  // account. Dropping it here means claimTotals' txnAmount-undefined guard skips the orphaned split,
  // so the write-off allocates only what's backed by a live transaction.
  const { data: txns, error: txnsError } = await supabase
    .from('transactions')
    .select('id, amount, date, user_category, pfc_primary')
    .eq('removed', false)
    .in('id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000'])
  if (txnsError) {
    return NextResponse.json({ error: 'could not read the claim’s transactions' }, { status: 500 })
  }

  const amountById: Record<string, number> = {}
  const categoryById: Record<string, string> = {}
  // Expense DATES, not amounts: allocateWriteOff settles repayments against the oldest expenses
  // first, so it needs to know which expense came first.
  const dateById: Record<string, string> = {}
  for (const t of txns ?? []) {
    amountById[t.id as string] = Number(t.amount)
    dateById[t.id as string] = t.date as string
    categoryById[t.id as string] = effectiveCategory(
      { user_category: t.user_category as string | null, pfc_primary: t.pfc_primary as string | null },
      pfcMap
    )
  }

  // Today in LOCAL time, matching every other month boundary in the app (budgets/page.tsx,
  // trends/page.tsx, lib/dashboard.ts all use getFullYear()/getMonth()). toISOString() would give
  // the UTC day instead: writing off at 17:30 on 31 July from a server ahead of UTC would stamp
  // 2026-08-01, so July's budget would not move and ClaimList's confirmation — "will be counted as
  // spending this month" — would be a lie the moment the user went looking for it.
  const now = new Date()
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate()
  ).padStart(2, '0')}`
  const rows = allocateWriteOff(claim as Claim, splitList, categoryById, amountById, dateById, date)

  // FAIL CLOSED on a short read. If the transactions above came back empty or truncated, every
  // split is skipped by claimTotals' txnAmount-undefined guard, `outstanding` computes as 0, and
  // allocateWriteOff returns [] — which reads exactly like "nothing to write off" and would fall
  // through to marking the claim written off with nothing written. The outstanding money would then
  // be gone from the books for good: DELETE refuses a written-off claim and there is no
  // un-write-off, so no user action can bring it back.
  //
  // Splits that resolved is the discriminator, NOT rows.length on its own. A fully-repaid claim
  // legitimately has outstanding <= 0 and legitimately writes off nothing — but its splits DID
  // resolve to transactions. Splits present and not one of them resolved means the read came back
  // short, not that the claim is settled.
  const resolvedSplits = splitList.filter((s) => amountById[s.transaction_id] !== undefined).length
  if (rows.length === 0 && splitList.length > 0 && resolvedSplits === 0) {
    return NextResponse.json(
      { error: 'could not read this claim’s transactions — nothing was written off, please try again' },
      { status: 500 }
    )
  }

  if (rows.length) {
    // Upsert, not insert: if the claim-mark below fails after this succeeds, a retry re-enters this
    // function (written_off_on is still null) and recomputes the same rows. The unique (claim_id,
    // category) constraint on reimbursement_write_offs makes that convergent — overwrite, not
    // duplicate — instead of silently double-counting the claim's spending.
    const { error } = await supabase
      .from('reimbursement_write_offs')
      .upsert(
        rows.map((r) => ({ ...r, household_id: hid })),
        { onConflict: 'claim_id,category' }
      )
    if (error) return NextResponse.json({ error: error.message }, { status: 400 })
  }
  const { error: markError } = await supabase
    .from('reimbursement_claims')
    // Unpin as part of writing off: the splits API refuses a written-off claim, so leaving it pinned
    // would keep offering a fast-path action that fails on every tap.
    .update({ written_off_on: date, pinned: false })
    .eq('id', id)
  if (markError) return NextResponse.json({ error: markError.message }, { status: 400 })

  return NextResponse.json({ ok: true, written: rows })
}

// Rename and/or pin. Both are independent optional fields so the two operations share one route
// without either becoming mandatory — the pin toggle sends only `pinned`, the rename only `name`.
export async function PATCH(req: Request) {
  const { id, name, pinned } = await req.json()
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const patch: { name?: string; pinned?: boolean } = {}
  if (name !== undefined) {
    const clean = String(name).trim()
    if (!clean) return NextResponse.json({ error: 'name cannot be empty' }, { status: 400 })
    patch.name = clean
  }
  if (pinned !== undefined) patch.pinned = !!pinned
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'nothing to update' }, { status: 400 })
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  // A written-off claim is closed for good and the splits API refuses to file against it, so
  // pinning one would surface an action the server rejects on every tap.
  if (patch.pinned) {
    const { data: claim } = await supabase
      .from('reimbursement_claims')
      .select('written_off_on')
      .eq('id', id)
      .maybeSingle()
    if (!claim) return NextResponse.json({ error: 'not found' }, { status: 404 })
    if (claim.written_off_on) {
      return NextResponse.json({ error: 'a written-off claim cannot be pinned' }, { status: 400 })
    }
  }

  const { error } = await supabase.from('reimbursement_claims').update(patch).eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 400 })
  return NextResponse.json({ ok: true })
}

// Deleting an OPEN claim cascades its splits (FK), so the money it was excluding returns to
// spending — that's correct and intended. The UI guards this with ConfirmDialog.
export async function DELETE(req: Request) {
  const { id } = await req.json()
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: claim } = await supabase
    .from('reimbursement_claims')
    .select('id, written_off_on')
    .eq('id', id)
    .single()
  if (!claim) return NextResponse.json({ error: 'not found' }, { status: 404 })
  // A written-off claim's reimbursement_write_offs rows are a frozen record of spending that
  // already counted in a (possibly closed) month. Deleting the claim would cascade-delete those
  // rows and un-exclude its splits, silently changing that month after the fact — exactly the
  // retroactive rewrite this feature exists to prevent. Only an open claim may be deleted.
  if (claim.written_off_on) {
    return NextResponse.json(
      { error: 'cannot delete a written-off claim: it is a frozen record of spending that already counted' },
      { status: 400 }
    )
  }

  const { error } = await supabase.from('reimbursement_claims').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 400 })
  return NextResponse.json({ ok: true })
}
