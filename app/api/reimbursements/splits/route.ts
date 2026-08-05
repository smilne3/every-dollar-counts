import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { claimTotals, type Claim, type Split } from '@/lib/reimbursements'
import { validateSplit, validateSplitDeletion } from '@/lib/split-validation'

async function household(supabase: Awaited<ReturnType<typeof createClient>>) {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return null
  const { data: m } = await supabase.from('memberships').select('household_id').limit(1).single()
  return m?.household_id ?? null
}

export async function POST(req: Request) {
  const { transactionId, claimId, owedBy, amount } = await req.json()
  if (!transactionId || !claimId) {
    return NextResponse.json({ error: 'transactionId and claimId required' }, { status: 400 })
  }
  const proposed = Number(amount)
  if (!Number.isFinite(proposed)) {
    return NextResponse.json({ error: 'amount must be a number' }, { status: 400 })
  }

  const supabase = await createClient()
  const hid = await household(supabase)
  if (!hid) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: txn } = await supabase
    .from('transactions')
    .select('id, amount')
    .eq('id', transactionId)
    .maybeSingle()
  if (!txn) return NextResponse.json({ error: 'transaction not found' }, { status: 404 })

  const { data: claim } = await supabase
    .from('reimbursement_claims')
    .select('id, name, written_off_on')
    .eq('id', claimId)
    .maybeSingle()
  if (!claim) return NextResponse.json({ error: 'claim not found' }, { status: 404 })
  // A written-off claim is closed for good: money arriving later is ordinary income, not a repayment.
  if (claim.written_off_on) {
    return NextResponse.json({ error: 'that claim is written off' }, { status: 400 })
  }

  const { data: onTxn } = await supabase
    .from('reimbursement_splits')
    .select('amount')
    .eq('transaction_id', transactionId)
  const existingOnTxn = (onTxn ?? []).reduce((s, r) => s + Number(r.amount), 0)

  // The claim's outstanding, needed to cap a repayment. Fetch this claim's splits and their txns.
  const { data: claimSplits } = await supabase
    .from('reimbursement_splits')
    .select('transaction_id, claim_id, owed_by, amount')
    .eq('claim_id', claimId)
  const ids = [...new Set(((claimSplits ?? []) as Split[]).map((s) => s.transaction_id))]
  const { data: claimTxns } = await supabase
    .from('transactions')
    .select('id, amount')
    .in('id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000'])
  const amountById: Record<string, number> = {}
  for (const t of claimTxns ?? []) amountById[t.id as string] = Number(t.amount)
  const { outstanding } = claimTotals(
    claim as Claim,
    (claimSplits ?? []) as Split[],
    amountById
  )

  const txnAmount = Number(txn.amount)
  const check = validateSplit({
    txnAmount,
    existingOnTxn,
    proposed,
    isRepayment: txnAmount < 0,
    claimOutstanding: outstanding,
  })
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 })

  // Known race: two rapid POSTs both read the same `existingOnTxn`/`outstanding` before either
  // writes, so they can jointly exceed the caps `validateSplit` just checked. No per-row `check`
  // constraint can close this — the constraint being enforced is a sum across sibling rows, which a
  // single row can't see. Accepted for now (ruled on, not revisited this round); closing it would
  // need an RPC doing the read-check-write atomically, or a serializable transaction.
  const { error } = await supabase.from('reimbursement_splits').insert({
    household_id: hid,
    transaction_id: transactionId,
    claim_id: claimId,
    owed_by: (owedBy ?? '').trim() || null,
    amount: proposed,
  })
  if (error) return NextResponse.json({ error: error.message }, { status: 400 })
  return NextResponse.json({ ok: true })
}

export async function DELETE(req: Request) {
  const { id } = await req.json()
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: split } = await supabase
    .from('reimbursement_splits')
    .select('id, transaction_id, claim_id, owed_by, amount')
    .eq('id', id)
    .maybeSingle()
  if (!split) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const { data: claim } = await supabase
    .from('reimbursement_claims')
    .select('id, name, written_off_on')
    .eq('id', split.claim_id)
    .maybeSingle()
  if (!claim) return NextResponse.json({ error: 'claim not found' }, { status: 404 })

  // Recompute the claim's totals as they'd be with this split already gone — that's the state
  // `validateSplitDeletion` needs to catch both a written-off claim (its splits are frozen history)
  // and an open claim that this delete would leave over-returned (see the function's comment).
  const { data: claimSplits } = await supabase
    .from('reimbursement_splits')
    .select('id, transaction_id, claim_id, owed_by, amount')
    .eq('claim_id', split.claim_id)
  const remaining = ((claimSplits ?? []) as (Split & { id: string })[]).filter((s) => s.id !== id)
  const ids = [...new Set(remaining.map((s) => s.transaction_id))]
  const { data: txns } = await supabase
    .from('transactions')
    .select('id, amount')
    .in('id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000'])
  const amountById: Record<string, number> = {}
  for (const t of txns ?? []) amountById[t.id as string] = Number(t.amount)
  const { owed, returned } = claimTotals(claim as Claim, remaining, amountById)

  const check = validateSplitDeletion({
    claimWrittenOff: claim.written_off_on !== null,
    remainingOwed: owed,
    remainingReturned: returned,
  })
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 })

  const { error } = await supabase.from('reimbursement_splits').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 400 })
  return NextResponse.json({ ok: true })
}
