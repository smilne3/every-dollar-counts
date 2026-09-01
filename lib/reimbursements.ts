// Reimbursable transactions (#27). A SPLIT says "this much of this transaction is owed back to me,
// under this claim, by this person". The UNSPLIT remainder of a transaction is the user's own
// spending, so there is no "my portion" field anywhere that could disagree with the splits.

export type Split = {
  transaction_id: string
  claim_id: string
  owed_by: string | null
  amount: number
}

// A transaction as the reimbursable math sees it. `reimbursable_amount` is how much of this
// transaction is coming back — always a positive magnitude, never signed. Direction is read from
// `amount` (Plaid: amount > 0 is money out), so there is no second field that could disagree with it.
export type ReimbursableTxn = {
  id: string
  amount: number
  reimbursable_amount: number | null
}

export type DatedReimbursableTxn = ReimbursableTxn & { date: string }
export type UnreimbursedRow = { id: string; date: string; remaining: number }

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

// Transaction id -> reimbursable amount, for spendableAmount.
//
// Unmarked rows are OMITTED rather than stored as 0: spendableAmount returns a transaction untouched
// when it finds no entry, which is what makes an empty map a provable no-op for every caller.
export function reimbursableByTxn(txns: ReimbursableTxn[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const t of txns) {
    const r = Number(t.reimbursable_amount ?? 0)
    if (r > 0) out[t.id] = r
  }
  return out
}

// What the household is owed: marked money that went out, less marked money that has come back.
//
// Clamped per the whole total at zero. An over-repayment is a surplus inflow, not a debt you owe the
// other party, and must never reduce net worth.
export function owedToYou(txns: ReimbursableTxn[]): number {
  let owed = 0
  for (const t of txns) {
    const r = Number(t.reimbursable_amount ?? 0)
    if (r <= 0) continue
    owed += t.amount > 0 ? r : -r
  }
  return Math.max(0, owed)
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

// The bucket a split with no `owed_by` lands in. Exported so the display layer can recognise it
// without re-typing the string — a per-person list whose only row is this one has nothing to say.
export const UNATTRIBUTED = 'Unattributed'

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
//
// REPAYMENTS SETTLE THE OLDEST EXPENSES FIRST (FIFO), and what is left unsettled is what gets
// written off, grouped by the category each unsettled expense came from. The obvious alternative —
// splitting `outstanding` pro-rata by LIFETIME owed per category — is wrong for a claim that is used
// for months and partly repaid: 12 months of fully-repaid dinners ($2,000, Food & Drink) plus one
// unrepaid $300 flight (Travel) would book $260.87 into Food & Drink, a category whose every expense
// has already come back. The money actually lost was the flight. FIFO says so.
//
// FROZEN, not derived: if this were recomputed on read, later editing a split would rewrite a month
// that had already closed — the retroactive rewrite the design explicitly rules out.
export function allocateWriteOff(
  claim: Claim,
  splits: Split[],
  categoryById: Record<string, string>,
  amountById: Record<string, number>,
  dateById: Record<string, string>,
  onDate: string
): WriteOff[] {
  const { owed, returned, outstanding } = claimTotals(claim, splits, amountById)
  if (outstanding <= 0 || owed <= 0) return []

  // The expense splits only (a repayment carries the payer's category and date, neither of which has
  // anything to do with what was bought), oldest first. Ties break on transaction id so the result
  // can never depend on the order the splits happened to come back from the database.
  const expenses = splits
    .filter((s) => {
      const txnAmount = amountById[s.transaction_id]
      return txnAmount !== undefined && txnAmount >= 0 // known, and not a repayment
    })
    .sort((a, b) => {
      const da = dateById[a.transaction_id] ?? ''
      const db = dateById[b.transaction_id] ?? ''
      if (da !== db) return da < db ? -1 : 1
      return a.transaction_id < b.transaction_id ? -1 : a.transaction_id > b.transaction_id ? 1 : 0
    })

  // Walk the expenses oldest-first, consuming everything that came back. Each expense is fully
  // settled before the next one is touched, so the unsettled tail is the RECENT money — which is
  // what a claim you keep reusing actually still owes you.
  let toSettle = returned
  const unsettledByCategory = new Map<string, number>()
  for (const s of expenses) {
    const settled = Math.min(s.amount, toSettle)
    toSettle -= settled
    const left = s.amount - settled
    if (left <= 0) continue
    // No effective category means the transaction fell out of the lookup entirely; it can't be
    // attributed, so it drops through to the remainder the last row absorbs rather than guessing.
    const cat = categoryById[s.transaction_id]
    if (!cat) continue
    unsettledByCategory.set(cat, (unsettledByCategory.get(cat) ?? 0) + left)
  }

  // A category whose expenses were all repaid contributes nothing and must NOT become a row: a
  // $0.00 write-off is real spending of nothing, and renders as a junk "Write-off · $0.00" line in
  // the transactions drill-down.
  const cats = [...unsettledByCategory.entries()].filter(([, left]) => round2(left) > 0)
  if (cats.length === 0) return []

  const rows: WriteOff[] = []
  let allocated = 0
  cats.forEach(([category, left], i) => {
    const isLast = i === cats.length - 1
    // The last row takes the remainder so the rows sum EXACTLY to `outstanding` — rounding each
    // share independently would lose or invent a cent.
    const amount = isLast ? round2(outstanding - allocated) : round2(left)
    allocated += amount
    rows.push({ claim_id: claim.id, category, amount, date: onDate })
  })
  // Only the remainder row can still land on zero (sub-cent residuals cancelling). Dropping a row
  // that is exactly 0 cannot change what the rows sum to, so the exact-sum guarantee survives it.
  return rows.filter((r) => r.amount !== 0)
}

// The expense report: marked expenses the marked deposits have not covered yet.
//
// Allocation is FIFO on AMOUNTS, never on dates. A date rule loses money — submit a report on the
// 15th, get paid on the 20th, and an expense on the 17th sits BEFORE the last deposit and reads as
// already-paid despite never having been claimed. Matching on amounts removes timing from the
// problem, which matters because this household submits on no fixed rhythm.
//
// Pure and stateless: nothing is stored, so it recomputes correctly no matter what order rows are
// marked in, and there is no settled-flag that could drift from the numbers it summarises.
export function unreimbursedExpenses(txns: DatedReimbursableTxn[]): UnreimbursedRow[] {
  const expenses = txns
    .filter((t) => t.amount > 0 && Number(t.reimbursable_amount ?? 0) > 0)
    .sort((a, b) => a.date.localeCompare(b.date))

  let pool = txns
    .filter((t) => t.amount < 0)
    .reduce((s, t) => s + Number(t.reimbursable_amount ?? 0), 0)

  const out: UnreimbursedRow[] = []
  for (const e of expenses) {
    const marked = Number(e.reimbursable_amount)
    const covered = Math.min(pool, marked)
    pool -= covered
    const remaining = round2(marked - covered)
    // Only a fully-covered expense should vanish: remaining = 0 means the pool exactly covered
    // the marked amount. The `> 0` rather than `!== 0` is defensive — remaining can never be
    // negative (Math.min guarantees covered <= marked), but `> 0` keeps it out if a future change
    // ever removes that clamp.
    if (remaining > 0) out.push({ id: e.id, date: e.date, remaining })
  }
  return out
}

// What may actually be stored in `reimbursable_amount`, given the transaction it belongs to.
//
// The database CHECK is the real guarantee; this exists so the app never ASKS for something the
// CHECK will refuse. Clamping turns "you typed more than the transaction is worth" into the obvious
// answer instead of a 500 from a constraint violation.
export function clampReimbursable(amount: number | null, txnAmount: number): number | null {
  if (amount === null || !Number.isFinite(amount) || amount <= 0) return null
  return Math.min(round2(amount), Math.abs(txnAmount))
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
