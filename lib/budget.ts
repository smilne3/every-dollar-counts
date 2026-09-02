import { effectiveCategory } from './effective-category'
import { isCreditCardPayment } from './categories'
import { spendableAmount } from './reimbursements'
import type { SpendContext } from './spend-context'

export type Txn = {
  id: string
  amount: number
  date: string
  user_category: string | null
  pfc_primary: string | null
  pfc_detailed: string | null
  reimbursable_amount: number | null
}

// 'YYYY-MM' bucket for a 'YYYY-MM-DD' date.
export function monthKey(date: string): string {
  return date.slice(0, 7)
}

// Sum spending per effective category NAME, net of anything reimbursable (#27).
export function spendByCategory(txns: Txn[], ctx: SpendContext): Record<string, number> {
  const out: Record<string, number> = {}
  for (const t of txns) {
    if (isCreditCardPayment(t)) continue // internal transfer, not spending
    const cat = effectiveCategory(t, ctx.pfcMap)
    if (ctx.nonSpending.has(cat)) continue // income + transfers
    // spendableAmount, not t.amount: the reimbursable portion is not the user's spending, and a
    // tagged repayment contributes 0 rather than netting the category down like a refund.
    // Outflows add; genuine refunds (untagged inflows in a spending category) still net down.
    out[cat] = (out[cat] ?? 0) + spendableAmount(t, ctx.reimbursedByTxn)
  }
  return out
}

// Spend that actually counts against budgets: only categories that have a limit set.
// Comparing TOTAL spend against a partial set of limits reports you over budget the
// moment you budget some categories but not all.
export function budgetedSpend(
  spendByCat: Record<string, number>,
  limits: Record<string, number>
): number {
  let total = 0
  for (const cat of Object.keys(limits)) total += spendByCat[cat] ?? 0
  return total
}

// Progress of spend against a limit: clamped ratio [0,1] plus an over-budget flag.
export function progress(spend: number, limit: number): { ratio: number; over: boolean } {
  const ratio = limit > 0 ? spend / limit : 0
  return { ratio: Math.min(Math.max(ratio, 0), 1), over: spend > limit }
}

// Rows whose date falls inside [from, to], both ends inclusive. Dates are 'YYYY-MM-DD', so a
// plain string comparison is chronological and no timezone maths is involved.
export function inRange<T extends { date: string }>(txns: T[], from: string, to: string): T[] {
  return txns.filter((t) => t.date >= from && t.date <= to)
}

// The two windows Trends compares: the month ending today, and the month before it.
//
// This replaces the calendar month, which on the 2nd had nothing to show but the mortgage (#67),
// and with it the `throughDay` cap that used to make a partial month comparable to a whole one
// (#9) — a full window on each side needs no capping.
//
// A fixed 30 days would be the obvious way to do that, and it is wrong. Thirty days is shorter
// than eleven months of twelve, so such a window drifts backwards through the calendar and, on
// about fifteen days a year, holds two 1st-of-month bills while its neighbour holds none. With a
// $3,929.35 mortgage that reads as "$7,858.70 vs $0.00". Anchoring to calendar months instead
// guarantees exactly one billing cycle per window; the price is windows of 28 to 31 days rather
// than 30, which skews variable spending by a few per cent instead of doubling a fixed cost.
export function rollingMonths(now: Date): {
  current: { from: string; to: string }
  previous: { from: string; to: string }
} {
  const oneBack = monthsBack(now, 1)
  const twoBack = monthsBack(now, 2)
  return {
    current: { from: isoDay(dayAfter(oneBack)), to: isoDay(now) },
    previous: { from: isoDay(dayAfter(twoBack)), to: isoDay(oneBack) },
  }
}

// `n` months before `now`, clamped into the target month: 31 March less one month is 28
// February, not an imaginary 31 February. Day 0 of the following month is the last day of the
// month we want, which is how the clamp learns that month's length.
function monthsBack(now: Date, n: number): Date {
  const lastDay = new Date(now.getFullYear(), now.getMonth() - n + 1, 0).getDate()
  return new Date(now.getFullYear(), now.getMonth() - n, Math.min(now.getDate(), lastDay))
}

function dayAfter(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)
}

// A Date's local calendar day as 'YYYY-MM-DD', to compare against transaction dates. Local
// parts, matching how the rest of the app reads `now`; day arithmetic goes through the Date
// constructor, which works in calendar days and so is unaffected by DST.
function isoDay(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}
