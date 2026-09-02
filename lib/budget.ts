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

// The two windows Trends compares: the month ending today, and the month before it. Full windows
// on both sides, which is what replaced the `throughDay` cap that used to make a partial month
// comparable to a whole one (#9).
//
// Anchored to calendar months rather than to a fixed 30 days. Each window then holds exactly one
// of every calendar day 1-28, so a bill on a fixed early-month date is counted once on each side.
// A fixed 30-day window holds no such guarantee: it is no longer than eleven months of twelve, so
// it drifts backwards through the calendar and lands two 1st-of-month bills in one window while
// its neighbour gets none. See tests/unit/budget.test.ts for the measurements.
//
// What neither scheme fixes: a bill that DRIFTS. The mortgage is due on the 1st but posts on the
// 3rd when the 1st is a Saturday (#67 notes exactly this for August), and two postings 29 days
// apart can both fall inside one month-long window. Anchoring makes that rarer than 30 days does
// — 5.0% of days against 7.4%, measured in budget.test.ts — but it does not remove it. Recognising
// a bill as one recurring commitment rather than as dated rows is #64's job, not this window's.
export function rollingMonths(now: Date): { current: DateWindow; previous: DateWindow } {
  // A window built from an invalid date would stringify to 'NaN-NaN-NaN' and reach the database
  // as a filter. Fail here, where the cause is legible.
  if (Number.isNaN(now.getTime())) {
    throw new Error('rollingMonths: invalid Date — cannot build a spending window')
  }
  const oneBack = monthsBack(now, 1)
  const twoBack = monthsBack(now, 2)
  return {
    current: { from: isoDay(dayAfter(oneBack)), to: isoDay(now) },
    previous: { from: isoDay(dayAfter(twoBack)), to: isoDay(oneBack) },
  }
}

// `n` months before `now`, clamped into the target month: 31 March less one month is the last day
// of February, not an imaginary 31 February. Day 0 of the following month is the last day of the
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
