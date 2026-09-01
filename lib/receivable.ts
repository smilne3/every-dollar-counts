import 'server-only'
import { createClient } from '@/lib/supabase/server'
import { owedToYou, type ReimbursableTxn } from '@/lib/reimbursements'

// NOTE: the pure `owedToYou` lives in lib/reimbursements.ts so it stays importable in unit tests —
// this module pulls in the request-scoped client at load.

// What the household is currently owed, for every surface that shows net worth.
//
// One function because the QUERY is where two surfaces would drift apart, not the arithmetic: a Net
// worth tile that disagrees with its own drill-down is the exact bug the drill-down was built to
// expose. Callers pass the total to netWorth(); nobody re-derives it.
export async function fetchReceivable(): Promise<number> {
  const supabase = await createClient()

  // Bounded by the partial index: only marked rows exist in it, and a household has few. `removed`
  // is a soft flag (a Plaid repost), not a delete, so its rows never disappear on their own — a
  // removed transaction's mark must not keep counting as money owed.
  // Same `.order('date', ...)` as app/(app)/reimbursements/page.tsx's query. Neither query bounds
  // rows by date — that would corrupt the FIFO allocation in unreimbursedExpenses — so both are
  // subject to PostgREST's 1000-row cap. Without a matching order, the two queries could truncate to
  // DIFFERENT 1000 rows past that cap and this dashboard total would disagree with the page's own.
  const { data, error } = await supabase
    .from('transactions')
    .select('id, amount, reimbursable_amount')
    .not('reimbursable_amount', 'is', null)
    .eq('removed', false)
    .order('date', { ascending: false })

  // Fail loudly rather than reporting $0 owed. An unchecked read here is issue #46 in a new costume:
  // "the query failed" and "you are owed nothing" must never render identically.
  if (error) throw new Error(`could not read reimbursable transactions: ${error.message}`)

  return owedToYou((data ?? []) as ReimbursableTxn[])
}
