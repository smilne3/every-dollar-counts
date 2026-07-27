import { effectiveCategory } from './effective-category'
import { isCreditCardPayment } from './categories'

export type Txn = {
  amount: number
  date: string
  user_category: string | null
  pfc_primary: string | null
  pfc_detailed: string | null
}

// 'YYYY-MM' bucket for a 'YYYY-MM-DD' date.
export function monthKey(date: string): string {
  return date.slice(0, 7)
}

// Sum spending (Plaid amount > 0 = money out) per effective category NAME.
// pfcMap = Plaid primary -> category name; nonSpending = category names to exclude.
export function spendByCategory(
  txns: Txn[],
  pfcMap: Record<string, string>,
  nonSpending: Set<string>
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const t of txns) {
    if (isCreditCardPayment(t)) continue // internal transfer, not spending
    const cat = effectiveCategory(t, pfcMap)
    if (nonSpending.has(cat)) continue // income + transfers
    // Outflows add; refunds (inflows in a spending category) net the category down.
    out[cat] = (out[cat] ?? 0) + t.amount
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

// Split spending per category name across this month vs last month.
// Compare this month against last month, per category. `throughDay` makes it apples-to-apples:
// this month is month-to-date, so last month is capped at the SAME day of the month (e.g. on the
// 14th, Jun 1–14 vs Jul 1–14). Without this cap, mid-month every category looks like a triumph —
// a partial month against a whole one — which is misleading on a budget tool (#9).
export function spendThisVsLast(
  txns: Txn[],
  thisM: string,
  lastM: string,
  pfcMap: Record<string, string>,
  nonSpending: Set<string>,
  throughDay: number
) {
  const thisMonth: Record<string, number> = {}
  const lastMonth: Record<string, number> = {}
  for (const t of txns) {
    if (isCreditCardPayment(t)) continue // internal transfer, not spending
    const cat = effectiveCategory(t, pfcMap)
    if (nonSpending.has(cat)) continue // income + transfers
    const mk = monthKey(t.date)
    // Outflows add; refunds (inflows in a spending category) net the category down.
    if (mk === thisM) {
      thisMonth[cat] = (thisMonth[cat] ?? 0) + t.amount
    } else if (mk === lastM && dayOfMonth(t.date) <= throughDay) {
      lastMonth[cat] = (lastMonth[cat] ?? 0) + t.amount
    }
  }
  return { thisMonth, lastMonth }
}

// Day component of a 'YYYY-MM-DD' date, as a number.
export function dayOfMonth(date: string): number {
  return Number(date.slice(8, 10))
}
