import { describe, it, expect } from 'vitest'
import { spendByCategory, inRange, rollingWindows, monthKey } from '@/lib/budget'
import { sortedSpendRows } from '@/lib/breakdown'
import type { SpendContext } from '@/lib/spend-context'

// #67: on the 2nd of the month, Trends showed two categories — the mortgage and one small
// charge — because both cards were keyed to the calendar month. This suite pins the fix:
// the same data, sliced into rolling windows, is representative on day 2 and stays fair.

const pfcMap: Record<string, string> = {
  LOAN_PAYMENTS: 'Loan Payments',
  GENERAL_MERCHANDISE: 'Shopping',
  FOOD_AND_DRINK: 'Food & Drink',
  RENT_AND_UTILITIES: 'Rent & Utilities',
  TRANSPORTATION: 'Transportation',
  PERSONAL_CARE: 'Personal Care',
  INCOME: 'Income',
}

const ctx: SpendContext = {
  pfcMap,
  nonSpending: new Set(['Income', 'Transfer In', 'Transfer Out']),
  transfers: new Set(['Transfer In', 'Transfer Out']),
  reimbursedByTxn: {},
}

let seq = 0
const t = (amount: number, date: string, pfc: string) => ({
  id: `t${++seq}`,
  amount,
  date,
  pfc_primary: pfc,
  pfc_detailed: null,
  user_category: null,
  reimbursable_amount: null,
})

// Shaped after the household's real August/September: a $3,929.35 mortgage on the 1st that
// dwarfs everything, ordinary living spread through the rest of the month.
const MORTGAGE = 3929.35
const txns = [
  // --- July, tail end (falls in the previous rolling window) ---
  t(64.2, '2026-07-08', 'FOOD_AND_DRINK'),
  t(210.0, '2026-07-19', 'GENERAL_MERCHANDISE'),
  t(36.32, '2026-07-24', 'RENT_AND_UTILITIES'),
  // --- August ---
  t(MORTGAGE, '2026-08-01', 'LOAN_PAYMENTS'),
  t(21.19, '2026-08-02', 'PERSONAL_CARE'),
  t(148.7, '2026-08-06', 'FOOD_AND_DRINK'),
  t(88.4, '2026-08-12', 'GENERAL_MERCHANDISE'),
  t(49.99, '2026-08-15', 'RENT_AND_UTILITIES'),
  t(34.99, '2026-08-21', 'TRANSPORTATION'),
  t(112.05, '2026-08-27', 'FOOD_AND_DRINK'),
  t(73.13, '2026-08-30', 'GENERAL_MERCHANDISE'),
  // --- September, the first two days ---
  t(MORTGAGE, '2026-09-01', 'LOAN_PAYMENTS'),
  t(19.81, '2026-09-02', 'GENERAL_MERCHANDISE'),
]

// 2 September 2026 — the date of the screenshot in #67.
const NOW = new Date(2026, 8, 2)
const { current, previous } = rollingWindows(NOW, 30)

const share = (byCat: Record<string, number>, cat: string) => {
  const total = Object.values(byCat).reduce((a, b) => a + b, 0)
  return byCat[cat] / total
}

describe('Trends on the 2nd of the month', () => {
  // The bug, stated as a test so it cannot come back unnoticed.
  it('had almost nothing to show when keyed to the calendar month', () => {
    const byCat = spendByCategory(
      txns.filter((x) => monthKey(x.date) === '2026-09'),
      ctx
    )
    expect(Object.keys(byCat)).toHaveLength(2)
    expect(share(byCat, 'Loan Payments')).toBeGreaterThan(0.99)
  })

  it('shows a representative spread over the rolling 30 days', () => {
    const byCat = spendByCategory(inRange(txns, current.from, current.to), ctx)
    expect(Object.keys(byCat).length).toBeGreaterThanOrEqual(5)
    // The mortgage is still the biggest line, and that is fine — what it must not be is
    // effectively the whole chart.
    expect(share(byCat, 'Loan Payments')).toBeLessThan(0.9)
  })

  it('reaches back into last month for spending the calendar view dropped', () => {
    const byCat = spendByCategory(inRange(txns, current.from, current.to), ctx)
    // Groceries on 6 and 27 August: invisible on a 1-September-onward view, present here.
    expect(byCat['Food & Drink']).toBeCloseTo(260.75)
    expect(byCat.Transportation).toBeCloseTo(34.99)
  })

  it('sorts the categories largest first, using the shared helper', () => {
    const rows = sortedSpendRows(spendByCategory(inRange(txns, current.from, current.to), ctx))
    expect(rows[0].category).toBe('Loan Payments')
    expect(rows.map((r) => r.amount)).toEqual([...rows.map((r) => r.amount)].sort((a, b) => b - a))
  })
})

describe('the two windows compare fairly', () => {
  // The reason spendThisVsLast's throughDay cap (#9) is no longer needed: each window is a
  // full 30 days, so each contains exactly one mortgage. Nothing has to be capped to make
  // the comparison honest.
  it('gives each window one full month of fixed costs', () => {
    const now = spendByCategory(inRange(txns, current.from, current.to), ctx)
    const before = spendByCategory(inRange(txns, previous.from, previous.to), ctx)
    expect(now['Loan Payments']).toBeCloseTo(MORTGAGE)
    expect(before['Loan Payments']).toBeCloseTo(MORTGAGE)
  })

  it('does not count a transaction in both windows', () => {
    const a = inRange(txns, current.from, current.to).map((x) => x.id)
    const b = inRange(txns, previous.from, previous.to).map((x) => x.id)
    expect(a.filter((id) => b.includes(id))).toEqual([])
  })
})
