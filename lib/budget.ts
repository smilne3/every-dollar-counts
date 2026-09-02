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

// A span of days, both ends inclusive. Both are 'YYYY-MM-DD', which is what makes a plain string
// comparison chronological — the `date` column is a Postgres `date` (db/migrations/003), so every
// value has that exact shape and no timezone maths is involved anywhere downstream.
export type DateWindow = { from: string; to: string }

// Rows falling inside the window. Takes the window whole rather than two loose strings, so a
// transposed call — which would return nothing and render an empty chart under a card header
// still confidently naming the dates — cannot be written.
export function inRange<T extends { date: string }>(txns: T[], w: DateWindow): T[] {
  return txns.filter((t) => t.date >= w.from && t.date <= w.to)
}

// The two windows Trends compares: the last calendar month that has actually finished, and the
// one before it. On 2 September that is August against July.
//
// Complete months, for two reasons that pull the same way:
//
// 1. A part-month is not worth charting. A window opening on the 1st is, for its first fortnight,
//    almost entirely the mortgage — true, unchanging, and not what anyone opened the page to
//    learn (#67). A finished month is always representative.
// 2. A monthly bill is monthly BY CALENDAR MONTH, so each window holds exactly one of it however
//    the posting date moves inside that month. A rolling month cannot promise this: the mortgage
//    is due on the 1st and posts on the 3rd when the 1st is a Saturday, and the rolling windows
//    put both August's and September's into one side and none into the other — $7,858.70 against
//    $0.00 on the real data, on 2 September 2026.
//
// The cost is recency: late in September you are still reading August. The dashboard's "Spent in
// September" tile and the Budgets page answer the current month; this page answers where the
// money goes, which wants a month that has stopped moving.
//
// The limitation, since the broader claim is false: this holds for a bill that posts within its
// own calendar month. One that crosses the boundary — 31 August falling on a Sunday and paying on
// 1 September — belongs to August but lands in September, and no calendar window can fix that.
// Knowing a payment is one recurring commitment rather than a dated row is #64's job.
export function lastCompleteMonths(now: Date): { current: DateWindow; previous: DateWindow } {
  // A window built from an invalid date would stringify to 'NaN-NaN-NaN' and reach the database
  // as a filter. Fail here, where the cause is legible.
  if (Number.isNaN(now.getTime())) {
    throw new Error('lastCompleteMonths: invalid Date — cannot build a spending window')
  }
  // Day 0 of a month is the last day of the one before it, which is how each window learns its
  // own length without anyone hard-coding 28, 30 or 31.
  const monthWindow = (monthsBack: number): DateWindow => ({
    from: isoDay(new Date(now.getFullYear(), now.getMonth() - monthsBack, 1)),
    to: isoDay(new Date(now.getFullYear(), now.getMonth() - monthsBack + 1, 0)),
  })
  return { current: monthWindow(1), previous: monthWindow(2) }
}

// A Date's local calendar day as 'YYYY-MM-DD', to compare against transaction dates. Local
// parts, matching how the rest of the app reads `now`; day arithmetic goes through the Date
// constructor, which works in calendar days and so is unaffected by DST.
function isoDay(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}
