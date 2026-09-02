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

// The two windows Trends compares: the `days` ending today, and the `days` immediately before
// them. Contiguous, non-overlapping, and the same length.
//
// This replaces the calendar month, which on the 2nd had nothing to show but the mortgage (#67),
// and with it the `throughDay` cap that used to make a partial month comparable to a whole one
// (#9) — two windows of equal length are fair by construction, so there is nothing left to cap.
export function rollingWindows(
  now: Date,
  days: number
): { current: { from: string; to: string }; previous: { from: string; to: string } } {
  // Local date parts, matching how the rest of the app reads `now`. Day arithmetic goes through
  // the Date constructor so month and year rollover are handled for us.
  const back = (n: number) =>
    isoDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - n))
  return {
    current: { from: back(days - 1), to: back(0) },
    previous: { from: back(days * 2 - 1), to: back(days) },
  }
}

// A Date's local calendar day as 'YYYY-MM-DD', to compare against transaction dates.
function isoDay(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}
