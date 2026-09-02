import { describe, it, expect } from 'vitest'
import { spendByCategory, rollingMonths, monthKey } from '@/lib/budget'
import { trendsView } from '@/lib/trends'
import type { SpendContext } from '@/lib/spend-context'

// #67: on the 2nd of the month, Trends showed two categories — the mortgage and one small
// charge — because both cards were keyed to the calendar month. This suite pins the fix: the
// same data, sliced into rolling months, is representative on day 2 and compares fairly.

const pfcMap: Record<string, string> = {
  LOAN_PAYMENTS: 'Loan Payments',
  GENERAL_MERCHANDISE: 'Shopping',
  FOOD_AND_DRINK: 'Food & Drink',
  RENT_AND_UTILITIES: 'Rent & Utilities',
  TRANSPORTATION: 'Transportation',
  PERSONAL_CARE: 'Personal Care',
  INCOME: 'Income',
}

const REIMBURSED = 200
const ctx: SpendContext = {
  pfcMap,
  nonSpending: new Set(['Income', 'Transfer In', 'Transfer Out']),
  transfers: new Set(['Transfer In', 'Transfer Out']),
  // A work expense in the current window, $200 of which is coming back (#27).
  reimbursedByTxn: { 'work-laptop-bag': REIMBURSED },
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

// Shaped after the household's real July-to-September: a $3,929.35 mortgage on the 1st that
// dwarfs everything, ordinary living spread through the rest of the month.
const MORTGAGE = 3929.35

// On 2 September the windows are [Aug 3 - Sep 2] and [Jul 3 - Aug 2].
const NOW = new Date(2026, 8, 2)
const windows = rollingMonths(NOW)

const txns = [
  // --- the previous window ---
  t(64.2, '2026-07-08', 'FOOD_AND_DRINK'),
  t(210.0, '2026-07-19', 'GENERAL_MERCHANDISE'),
  t(36.32, '2026-07-24', 'RENT_AND_UTILITIES'),
  t(MORTGAGE, '2026-08-01', 'LOAN_PAYMENTS'),
  t(21.19, '2026-08-02', 'PERSONAL_CARE'),
  // --- the current window ---
  t(148.7, '2026-08-06', 'FOOD_AND_DRINK'),
  t(132.4, '2026-08-08', 'FOOD_AND_DRINK'),
  t(88.4, '2026-08-12', 'GENERAL_MERCHANDISE'),
  t(49.99, '2026-08-15', 'RENT_AND_UTILITIES'),
  t(245.6, '2026-08-18', 'GENERAL_MERCHANDISE'),
  t(34.99, '2026-08-21', 'TRANSPORTATION'),
  t(217.97, '2026-08-24', 'RENT_AND_UTILITIES'),
  t(112.05, '2026-08-27', 'FOOD_AND_DRINK'),
  t(68.39, '2026-08-29', 'FOOD_AND_DRINK'),
  t(73.13, '2026-08-30', 'GENERAL_MERCHANDISE'),
  t(MORTGAGE, '2026-09-01', 'LOAN_PAYMENTS'),
  t(19.81, '2026-09-02', 'GENERAL_MERCHANDISE'),
  // A credit-card autopay in the current window. It is not spending (#31), and it carries the
  // same PFC as the mortgage, so if the exclusion ever broke it would land on the very category
  // this page is trying to stop over-reporting.
  {
    id: 'card-autopay',
    amount: 1200,
    date: '2026-08-20',
    pfc_primary: 'LOAN_PAYMENTS',
    pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT',
    user_category: null,
    reimbursable_amount: null,
  },
  // A refund (#8): an inflow in a spending category nets that category down rather than counting
  // as income. Rolling windows make this newly interesting — the boundary moves daily, so a
  // purchase and its refund can end up on opposite sides of it, which a calendar month held
  // together for a whole month at a time.
  t(-40.0, '2026-08-26', 'GENERAL_MERCHANDISE'),
  // A $300 work expense with $200 coming back: only the $100 share is spending (#27).
  {
    id: 'work-laptop-bag',
    amount: 300,
    date: '2026-08-14',
    pfc_primary: 'GENERAL_MERCHANDISE',
    pfc_detailed: null,
    user_category: null,
    reimbursable_amount: REIMBURSED,
  },
]

// Everything below goes through the same function the page calls, so a regression in the
// composition — the wrong window on a card, a dropped default, a swapped label — fails here.
const view = trendsView(windows, txns, ctx)

const byCategory = (rows: { category: string; amount: number }[]) =>
  Object.fromEntries(rows.map((r) => [r.category, r.amount]))

const inCurrent = () => byCategory(view.spend.rows)
const inPrevious = () =>
  Object.fromEntries(view.compare.rows.map((r) => [r.category, r.previous]))

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

  it('shows a representative spread over the rolling month', () => {
    const byCat = inCurrent()
    expect(Object.keys(byCat).length).toBeGreaterThanOrEqual(5)
    // The mortgage is still the biggest line, and that is fine — what it must not be is
    // effectively the whole chart.
    expect(share(byCat, 'Loan Payments')).toBeLessThan(0.8)
  })

  it('reaches back into last month for spending the calendar view dropped', () => {
    const byCat = inCurrent()
    // Four grocery runs across August: invisible on a 1-September-onward view, present here.
    expect(byCat['Food & Drink']).toBeCloseTo(461.54)
    expect(byCat.Transportation).toBeCloseTo(34.99)
  })

  it('sorts the categories largest first', () => {
    const rows = view.spend.rows
    expect(rows[0].category).toBe('Loan Payments')
    expect(rows.map((r) => r.amount)).toEqual([...rows.map((r) => r.amount)].sort((a, b) => b - a))
  })
})

describe('the rolling slice keeps the exclusions the totals use', () => {
  // A card payment shares the mortgage's category, so a broken exclusion would inflate the
  // single line this page most needs to report honestly.
  it('leaves a credit-card payment out of spending (#31)', () => {
    expect(inCurrent()['Loan Payments']).toBeCloseTo(MORTGAGE)
  })

  it('counts only the unreimbursed share of a work expense (#27)', () => {
    // 88.40 + 245.60 + 73.13 + 19.81 of shopping, less a 40.00 refund, plus 300 - 200 of the
    // work expense.
    expect(inCurrent().Shopping).toBeCloseTo(486.94)
  })
})

describe('the two windows compare fairly', () => {
  // Why throughDay (#9) is no longer needed: in this fixture each window is a full month holding
  // one mortgage, so neither side is a partial month against a whole one. (The general property,
  // and the case a drifting bill still breaks, are pinned in budget.test.ts.)
  it('gives each window one full month of fixed costs', () => {
    expect(inCurrent()['Loan Payments']).toBeCloseTo(MORTGAGE)
    expect(inPrevious()['Loan Payments']).toBeCloseTo(MORTGAGE)
  })

  it('has something to compare on both sides', () => {
    expect(Object.keys(inPrevious()).length).toBeGreaterThanOrEqual(5)
  })

  // A category that only exists on one side still belongs on the chart, at zero for the other —
  // otherwise "you spent nothing on this" and "this category does not exist" look the same.
  it('carries a one-sided category across at zero', () => {
    const transport = view.compare.rows.find((r) => r.category === 'Transportation')
    expect(transport).toEqual({ category: 'Transportation', current: 34.99, previous: 0 })
    const personal = view.compare.rows.find((r) => r.category === 'Personal Care')
    expect(personal).toEqual({ category: 'Personal Care', current: 0, previous: 21.19 })
  })
})

describe('the comparison rows are rounded to cents', () => {
  // Money summed in binary floating point does not land on a cent: three $0.10 charges total
  // 0.30000000000000004, and recharts would render the tooltip with every digit of it.
  it('rounds a floating-point sum to a real amount', () => {
    const pennies = [
      t(0.1, '2026-08-10', 'FOOD_AND_DRINK'),
      t(0.1, '2026-08-11', 'FOOD_AND_DRINK'),
      t(0.1, '2026-08-12', 'FOOD_AND_DRINK'),
    ]
    const v = trendsView(windows, pennies, ctx)
    const row = v.compare.rows.find((r) => r.category === 'Food & Drink')
    expect(row?.current).toBe(0.3)
  })
})

describe('each card is labelled with the window it actually shows', () => {
  // #67 was, at bottom, a page showing one window under a heading naming another. These pin the
  // pairing, so a swapped prop fails here rather than in front of the reader.
  it('names the current window on the spending card', () => {
    expect(view.spend.dates).toBe('Aug 3 – Sep 2')
  })

  it('names both windows, current first, on the comparison card', () => {
    expect(view.compare.dates).toBe('Aug 3 – Sep 2 vs Jul 3 – Aug 2')
    expect(view.compare.currentLabel).toBe('Past month')
    expect(view.compare.previousLabel).toBe('Month before')
  })

  // The spending card shows the CURRENT window, not the previous one. The two are close enough
  // in shape that plotting the wrong one looks entirely plausible.
  it('plots the current window on the spending card, not the previous', () => {
    const spend = byCategory(view.spend.rows)
    expect(spend['Food & Drink']).toBeCloseTo(461.54) // current; previous is 64.20
    expect(spend['Personal Care']).toBeUndefined() // previous-only category
  })
})
