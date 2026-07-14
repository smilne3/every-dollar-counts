import { effectiveCategory } from './effective-category'
import { monthKey } from './budget'

export type FlowTxn = {
  amount: number
  date: string
  user_category: string | null
  pfc_primary: string | null
}

export type Acct = { type: string | null; current_balance: number | null }

const ASSET_TYPES = new Set(['depository', 'investment', 'other'])
const LIABILITY_TYPES = new Set(['credit', 'loan'])

// Plaid reports credit/loan balances as POSITIVE amounts owed, so a mortgage looks
// identical to a savings account unless callers ask.
export function isLiability(type: string | null): boolean {
  return LIABILITY_TYPES.has(type ?? '')
}

// Net worth = assets - liabilities across all connected accounts.
export function netWorth(accounts: Acct[]): number {
  let assets = 0
  let liabilities = 0
  for (const a of accounts) {
    const bal = a.current_balance ?? 0
    if (ASSET_TYPES.has(a.type ?? '')) assets += bal
    else if (LIABILITY_TYPES.has(a.type ?? '')) liabilities += bal
  }
  return assets - liabilities
}

// Cash on hand = balances in spendable (depository) accounts.
export function cashOnHand(accounts: Acct[]): number {
  return accounts
    .filter((a) => a.type === 'depository')
    .reduce((s, a) => s + (a.current_balance ?? 0), 0)
}

const MONTH_LABELS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]

// The last `n` months (chronological), each as { key: 'YYYY-MM', label: 'Jul' }.
export function lastNMonths(now: Date, n: number): { key: string; label: string }[] {
  const out: { key: string; label: string }[] = []
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    out.push({ key, label: MONTH_LABELS[d.getMonth()] })
  }
  return out
}

// Money out (spending) and money in (income) per month.
// Plaid convention: amount > 0 = money OUT, amount < 0 = money IN.
// - spending excludes `spendingExclude` (income + transfers) so transfers/paychecks
//   never count as spending.
// - income excludes `incomeExclude` (transfers only) so paychecks still count as
//   income but moving money between your own accounts does not.
export function monthlyFlows(
  txns: FlowTxn[],
  pfcMap: Record<string, string>,
  spendingExclude: Set<string>,
  incomeExclude: Set<string>,
  months: { key: string; label: string }[]
): { key: string; label: string; spending: number; income: number }[] {
  const acc: Record<string, { spending: number; income: number }> = {}
  for (const m of months) acc[m.key] = { spending: 0, income: 0 }
  for (const t of txns) {
    const mk = monthKey(t.date)
    const bucket = acc[mk]
    if (!bucket) continue
    const cat = effectiveCategory(t, pfcMap)
    if (t.amount > 0) {
      if (!spendingExclude.has(cat)) bucket.spending += t.amount
    } else if (t.amount < 0) {
      if (!incomeExclude.has(cat)) bucket.income += -t.amount
    }
  }
  return months.map((m) => ({ ...m, ...acc[m.key] }))
}
