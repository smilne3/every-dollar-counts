// Reimbursable transactions (#27). `reimbursable_amount` lives directly on the transaction: how much
// of it is coming back — always a positive magnitude, never signed. Direction is read from `amount`
// (Plaid: amount > 0 is money out), so there is no second field that could disagree with it.

// A transaction as the reimbursable math sees it.
export type ReimbursableTxn = {
  id: string
  amount: number
  reimbursable_amount: number | null
}

export type DatedReimbursableTxn = ReimbursableTxn & { date: string }
export type UnreimbursedRow = { id: string; date: string; remaining: number }

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

// THE rule, in one expression: a marked amount pulls a transaction's contribution toward zero, in
// whichever direction it already points (Plaid: amount > 0 is money out).
//   $1,000 outflow, $750 marked  ->  $250 of spending
//   -$260 repayment, $250 marked -> -$10, so the surplus stays an inflow and is treated exactly as
//                                   any untagged $10 inflow of that category would be
// A transaction with no entry in `reimbursed` is returned untouched, which is what makes an empty map
// a provable no-op for every caller.
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
