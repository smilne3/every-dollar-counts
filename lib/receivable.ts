import 'server-only'
import { createClient } from '@/lib/supabase/server'
import { receivableTotal, type Claim, type Split } from '@/lib/reimbursements'

// NOTE: the pure `receivableTotal` lives in lib/reimbursements.ts (with the rest of the claim math)
// so it stays importable in unit tests — this module pulls in the request-scoped client at load.

// What the household is currently owed back, for every surface that shows net worth.
//
// This exists as ONE function because the query is where the two surfaces would drift apart, not the
// arithmetic. Three separate conditions below each silently change the answer if a caller forgets
// one, and a Net worth tile that disagrees with its own drill-down is the exact bug the drill-down
// was built to expose. Callers pass the total to netWorth(); nobody re-derives it.
export async function fetchReceivable(): Promise<number> {
  const supabase = await createClient()

  // Open claims only. A written-off claim's unreturned amount is already frozen as spending, so
  // counting it here would both overstate net worth and count the same dollars twice.
  const { data: claimRows } = await supabase
    .from('reimbursement_claims')
    .select('id, name, written_off_on')
    .is('written_off_on', null)

  const { data: splitRows } = await supabase
    .from('reimbursement_splits')
    .select('transaction_id, claim_id, owed_by, amount')
  const splits = ((splitRows ?? []) as unknown as Split[]).map((s) => ({
    ...s,
    amount: Number(s.amount),
  }))

  // BOUNDED to the transactions the splits actually reference, never the whole table: PostgREST caps
  // a select at the project's max-rows setting (1000 by default) and truncates SILENTLY, so an
  // unbounded read stops covering the splits once the household passes that many transactions —
  // claimTotals then skips every split whose transaction fell outside the page and the receivable
  // quietly shrinks. The sentinel id keeps the list non-empty: PostgREST rejects an empty `in.()`
  // rather than treating it as "matches nothing".
  const txnIds = [...new Set(splits.map((s) => s.transaction_id))]
  // `removed` is a soft flag (a Plaid repost), not a delete, so the FK cascade never fires for it.
  // Excluding it here is what drops its splits from the total, via claimTotals' undefined guard.
  const { data: txns } = await supabase
    .from('transactions')
    .select('id, amount')
    .eq('removed', false)
    .in('id', txnIds.length ? txnIds : ['00000000-0000-0000-0000-000000000000'])

  const amountById: Record<string, number> = {}
  for (const t of txns ?? []) amountById[t.id as string] = Number(t.amount)

  return receivableTotal((claimRows ?? []) as Claim[], splits, amountById)
}
