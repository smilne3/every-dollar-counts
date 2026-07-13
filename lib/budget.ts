import { effectiveCategory } from './effective-category'

export type Txn = {
  amount: number
  date: string
  user_category: string | null
  pfc_primary: string | null
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
    if (t.amount <= 0) continue
    const cat = effectiveCategory(t, pfcMap)
    if (nonSpending.has(cat)) continue
    out[cat] = (out[cat] ?? 0) + t.amount
  }
  return out
}

// Progress of spend against a limit: clamped ratio [0,1] plus an over-budget flag.
export function progress(spend: number, limit: number): { ratio: number; over: boolean } {
  const ratio = limit > 0 ? spend / limit : 0
  return { ratio: Math.min(Math.max(ratio, 0), 1), over: spend > limit }
}

// Split spending per category name across this month vs last month.
export function spendThisVsLast(
  txns: Txn[],
  thisM: string,
  lastM: string,
  pfcMap: Record<string, string>,
  nonSpending: Set<string>
) {
  const thisMonth: Record<string, number> = {}
  const lastMonth: Record<string, number> = {}
  for (const t of txns) {
    if (t.amount <= 0) continue
    const cat = effectiveCategory(t, pfcMap)
    if (nonSpending.has(cat)) continue
    const mk = monthKey(t.date)
    if (mk === thisM) thisMonth[cat] = (thisMonth[cat] ?? 0) + t.amount
    else if (mk === lastM) lastMonth[cat] = (lastMonth[cat] ?? 0) + t.amount
  }
  return { thisMonth, lastMonth }
}
