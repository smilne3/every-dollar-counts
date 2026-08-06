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

export type PersonTotal = {
  owedBy: string // 'Unattributed' when the split has no owed_by
  owed: number
  returned: number
  outstanding: number
}

export type ClaimTotals = {
  owed: number
  returned: number
  outstanding: number
  settled: boolean // DERIVED from the totals — deliberately not a stored column
  writtenOff: boolean
  byPerson: PersonTotal[] // biggest outstanding first
}

const UNATTRIBUTED = 'Unattributed'

// Totals for ONE claim. `splits` must be that claim's splits; `amountById` maps transaction id to
// its signed amount, which is how a split's direction is read: a split on an outflow is money owed
// to you, a split on an inflow is money that came back.
export function claimTotals(
  claim: Claim,
  splits: Split[],
  amountById: Record<string, number>
): ClaimTotals {
  const people = new Map<string, PersonTotal>()
  let owed = 0
  let returned = 0

  for (const s of splits) {
    const txnAmount = amountById[s.transaction_id]
    // Unknown transaction (deleted, or outside the fetched window): skip rather than guess, since it
    // has no direction and would silently be treated as an expense, inflating what the claim is owed.
    if (txnAmount === undefined) continue
    const isRepayment = txnAmount < 0

    const key = s.owed_by?.trim() || UNATTRIBUTED
    const p = people.get(key) ?? { owedBy: key, owed: 0, returned: 0, outstanding: 0 }
    if (isRepayment) {
      returned += s.amount
      p.returned += s.amount
    } else {
      owed += s.amount
      p.owed += s.amount
    }
    p.outstanding = p.owed - p.returned
    people.set(key, p)
  }

  const outstanding = owed - returned
  return {
    owed,
    returned,
    outstanding,
    settled: outstanding <= 0,
    writtenOff: claim.written_off_on !== null,
    byPerson: [...people.values()].sort((a, b) => b.outstanding - a.outstanding),
  }
}

// Freeze a claim's unreturned amount into spending rows, dated the day the user gave up.
// Allocated pro-rata across the categories the expenses came from, so budgets and the per-category
// breakdown stay coherent for a claim that spanned Travel and Food & Drink.
// FROZEN, not derived: if this were recomputed on read, later editing a split would rewrite a month
// that had already closed — the retroactive rewrite the design explicitly rules out.
export function allocateWriteOff(
  claim: Claim,
  splits: Split[],
  categoryById: Record<string, string>,
  amountById: Record<string, number>,
  onDate: string
): WriteOff[] {
  const { owed, outstanding } = claimTotals(claim, splits, amountById)
  if (outstanding <= 0 || owed <= 0) return []

  // Owed per category, from the expense splits only (repayments carry the payer's category, which
  // has nothing to do with what was bought).
  const owedByCategory = new Map<string, number>()
  for (const s of splits) {
    const txnAmount = amountById[s.transaction_id]
    if (txnAmount === undefined || txnAmount < 0) continue // unknown, or a repayment
    const cat = categoryById[s.transaction_id]
    if (!cat) continue
    owedByCategory.set(cat, (owedByCategory.get(cat) ?? 0) + s.amount)
  }
  if (owedByCategory.size === 0) return []

  const cats = [...owedByCategory.entries()]
  const rows: WriteOff[] = []
  let allocated = 0
  cats.forEach(([category, catOwed], i) => {
    const isLast = i === cats.length - 1
    // The last row takes the remainder so the rows sum EXACTLY to `outstanding` — rounding each
    // share independently would lose or invent a cent.
    const amount = isLast
      ? round2(outstanding - allocated)
      : round2((catOwed / owed) * outstanding)
    allocated += amount
    rows.push({ claim_id: claim.id, category, amount, date: onDate })
  })
  return rows
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
