// Reimbursable transactions (#27). A SPLIT says "this much of this transaction is owed back to me,
// under this claim, by this person". The UNSPLIT remainder of a transaction is the user's own
// spending, so there is no "my portion" field anywhere that could disagree with the splits.

export type Split = {
  transaction_id: string
  claim_id: string
  owed_by: string | null
  amount: number
}

export type Claim = {
  id: string
  name: string
  written_off_on: string | null // null = open; set = written off
}

export type WriteOff = {
  claim_id: string
  category: string // effective-category NAME
  amount: number
  date: string // the write-off date, not the original expense date
}

// Transaction-shaped value synthesised from a write-off. Never persisted to `transactions`.
export type WriteOffTxn = {
  id: string
  amount: number
  date: string
  user_category: string
  pfc_primary: null
  pfc_detailed: null
}

// Split amounts summed per transaction id.
export function reimbursedByTxn(splits: Split[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const s of splits) {
    out[s.transaction_id] = (out[s.transaction_id] ?? 0) + s.amount
  }
  return out
}

// THE rule, in one expression: splits pull a transaction's contribution toward zero, in whichever
// direction it already points (Plaid: amount > 0 is money out).
//   $1,000 outflow, $750 split  ->  $250 of spending
//   -$260 repayment, $250 split -> -$10, so the surplus stays an inflow and is treated exactly as
//                                  any untagged $10 inflow of that category would be
// A transaction with no splits is returned untouched, which is what makes an empty split map a
// provable no-op for every caller.
export function spendableAmount(
  t: { id: string; amount: number },
  reimbursed: Record<string, number>
): number {
  const r = reimbursed[t.id] ?? 0
  if (!r) return t.amount
  const net = Math.max(0, Math.abs(t.amount) - r)
  if (net === 0) return 0
  return t.amount < 0 ? -net : net
}

// Write-offs become in-memory transactions so the three spending functions need no write-off logic
// of their own: `effectiveCategory` honours user_category first, so each row lands in the category
// it was allocated to. NOTHING here is written to `transactions` — the user's ledger must keep
// matching their bank statement.
export function writeOffsAsTxns(writeOffs: WriteOff[]): WriteOffTxn[] {
  return writeOffs.map((w, i) => ({
    // Prefixed so it can never collide with a real (uuid) transaction id and therefore can never
    // pick up a split. The index keeps multi-category write-offs distinct.
    id: `writeoff:${w.claim_id}:${i}`,
    amount: w.amount,
    date: w.date,
    user_category: w.category,
    pfc_primary: null,
    pfc_detailed: null,
  }))
}
