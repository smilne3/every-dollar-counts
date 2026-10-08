import { describe, it, expect } from 'vitest'
import { spendByCategory, lastCompleteMonths, monthKey } from '@/lib/budget'
import { trendsView, capCategories } from '@/lib/trends'
import { buildSpendContext, type SpendContext } from '@/lib/spend-context'
import { categoriesFromMap, testData } from './helpers/category-context'

// #67: on the 2nd of the month, Trends showed two categories — the mortgage and one small charge
// — because both cards were keyed to the month in progress. This suite pins the fix: report the
// last month that has FINISHED, which is always representative and always holds exactly one of a
// monthly bill.
//
// The fixture mirrors the household's real mortgage postings — 1 July, 3 August (the 1st was a
// Saturday), 1 September — because those dates are what exposed the rolling-window version
// charting $7,858.70 against $0.00.

const pfcMap: Record<string, string> = {
  LOAN_PAYMENTS: 'Loan Payments',
  GENERAL_MERCHANDISE: 'Shopping',
  FOOD_AND_DRINK: 'Food & Drink',
  RENT_AND_UTILITIES: 'Utilities',
  TRANSPORTATION: 'Transportation',
  PERSONAL_CARE: 'Personal Care',
  INCOME: 'Income',
}

const REIMBURSED = 200
// Transfer In and Transfer Out are added because the old hand-built context's transfer set always
// held them, whatever the map.
const ctx: SpendContext = {
  ...buildSpendContext({
    data: testData(categoriesFromMap({ ...pfcMap, TRANSFER_IN: 'Transfer In', TRANSFER_OUT: 'Transfer Out' })),
    txns: [],
  }),
  reimbursedByTxn: { 'work-laptop-bag': REIMBURSED },
}

let seq = 0
const t = (amount: number, date: string, pfc: string) => ({
  id: `t${++seq}`,
  amount,
  date,
  pfc_primary: pfc,
  pfc_detailed: null,
  merchant_name: null,
  user_category: null,
  reimbursable_amount: null,
})

const MORTGAGE = 3929.35

// On 2 September the windows are August (finished) and July.
const NOW = '2026-09-02'
const windows = lastCompleteMonths(NOW)

const txns = [
  // --- July: the previous window ---
  t(MORTGAGE, '2026-07-01', 'LOAN_PAYMENTS'),
  t(64.2, '2026-07-08', 'FOOD_AND_DRINK'),
  t(210.0, '2026-07-19', 'GENERAL_MERCHANDISE'),
  t(36.32, '2026-07-24', 'RENT_AND_UTILITIES'),
  t(21.19, '2026-07-30', 'PERSONAL_CARE'),
  // --- August: the current window. The mortgage posted on the 3rd, not the 1st. ---
  t(MORTGAGE, '2026-08-03', 'LOAN_PAYMENTS'),
  t(148.7, '2026-08-06', 'FOOD_AND_DRINK'),
  t(132.4, '2026-08-08', 'FOOD_AND_DRINK'),
  t(88.4, '2026-08-12', 'GENERAL_MERCHANDISE'),
  t(49.99, '2026-08-15', 'RENT_AND_UTILITIES'),
  t(245.6, '2026-08-18', 'GENERAL_MERCHANDISE'),
  t(34.99, '2026-08-21', 'TRANSPORTATION'),
  t(217.97, '2026-08-24', 'RENT_AND_UTILITIES'),
  // A refund (#8): an inflow in a spending category nets that category down rather than counting
  // as income.
  t(-40.0, '2026-08-26', 'GENERAL_MERCHANDISE'),
  t(112.05, '2026-08-27', 'FOOD_AND_DRINK'),
  t(68.39, '2026-08-29', 'FOOD_AND_DRINK'),
  t(73.13, '2026-08-30', 'GENERAL_MERCHANDISE'),
  // --- September: in progress, so neither card should see any of it ---
  t(MORTGAGE, '2026-09-01', 'LOAN_PAYMENTS'),
  t(19.81, '2026-09-02', 'GENERAL_MERCHANDISE'),
  // A credit-card autopay. Not spending (#31), and it carries the mortgage's own category, so a
  // broken exclusion would land on the line this page most needs to report honestly.
  {
    id: 'card-autopay',
    amount: 1200,
    date: '2026-08-20',
    pfc_primary: 'LOAN_PAYMENTS',
    pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT',
    merchant_name: null,
    user_category: null,
    reimbursable_amount: null,
  },
  // A $300 work expense with $200 coming back: only the $100 share is spending (#27).
  {
    id: 'work-laptop-bag',
    amount: 300,
    date: '2026-08-14',
    pfc_primary: 'GENERAL_MERCHANDISE',
    pfc_detailed: null,
    merchant_name: null,
    user_category: null,
    reimbursable_amount: REIMBURSED,
  },
]

const view = trendsView(windows, txns, ctx)
const byCategory = (rows: { category: string; amount: number }[]) =>
  Object.fromEntries(rows.map((r) => [r.category, r.amount]))
const inCurrent = () => byCategory(view.spend.rows)
const inPrevious = () => Object.fromEntries(view.compare.rows.map((r) => [r.category, r.previous]))
const share = (byCat: Record<string, number>, cat: string) => {
  const total = Object.values(byCat).reduce((a, b) => a + b, 0)
  return byCat[cat] / total
}

describe('Trends on the 2nd of the month', () => {
  // The bug, stated as a test so it cannot come back unnoticed.
  it('had almost nothing to show when keyed to the month in progress', () => {
    const byCat = spendByCategory(
      txns.filter((x) => monthKey(x.date) === '2026-09'),
      ctx
    )
    expect(Object.keys(byCat)).toHaveLength(2)
    expect(share(byCat, 'Loan Payments')).toBeGreaterThan(0.99)
  })

  it('shows a representative spread by reporting the finished month instead', () => {
    const byCat = inCurrent()
    expect(Object.keys(byCat).length).toBeGreaterThanOrEqual(5)
    // The mortgage is still the biggest line, and that is fine — what it must not be is
    // effectively the whole chart.
    expect(share(byCat, 'Loan Payments')).toBeLessThan(0.8)
  })

  it('leaves the month in progress out of both cards entirely', () => {
    // The fixture holds THREE mortgages — 1 Jul, 3 Aug, 1 Sep — and September has not finished,
    // so exactly two of them may appear anywhere on this page.
    const loans = view.compare.rows.find((r) => r.category === 'Loan Payments')
    expect(loans!.current + loans!.previous).toBeCloseTo(MORTGAGE * 2)
    // September's lone $19.81 charge must not reach the shopping total either.
    expect(inCurrent().Shopping).toBeCloseTo(467.13)
  })

  it('sorts the categories largest first', () => {
    const rows = view.spend.rows
    expect(rows[0].category).toBe('Loan Payments')
    expect(rows.map((r) => r.amount)).toEqual([...rows.map((r) => r.amount)].sort((a, b) => b - a))
  })
})

describe('a mortgage that drifts off the 1st', () => {
  // The regression this window shape exists for. Against these exact postings the rolling-month
  // version put August's (3rd) and September's (1st) into one window and left the other empty,
  // charting $7,858.70 against $0.00 on the live page.
  it('counts once on each side even though August posted on the 3rd', () => {
    expect(inCurrent()['Loan Payments']).toBeCloseTo(MORTGAGE)
    expect(inPrevious()['Loan Payments']).toBeCloseTo(MORTGAGE)
  })

  it('never doubles it into one side and empties the other', () => {
    const loans = view.compare.rows.find((r) => r.category === 'Loan Payments')
    // The exact failure seen on the live page: $7,858.70 against $0.00.
    expect(loans?.current).not.toBeCloseTo(MORTGAGE * 2)
    expect(loans?.previous).not.toBe(0)
  })
})

describe('the slice keeps the exclusions the totals use', () => {
  it('leaves a credit-card payment out of spending (#31)', () => {
    expect(inCurrent()['Loan Payments']).toBeCloseTo(MORTGAGE)
  })

  it('counts only the unreimbursed share of a work expense (#27)', () => {
    // 88.40 + 245.60 + 73.13 of shopping, less a 40.00 refund, plus 300 - 200 of the work expense.
    expect(inCurrent().Shopping).toBeCloseTo(467.13)
  })

  it('reaches a whole month of ordinary living', () => {
    expect(inCurrent()['Food & Drink']).toBeCloseTo(461.54)
    expect(inCurrent().Transportation).toBeCloseTo(34.99)
  })
})

describe('the comparison rows', () => {
  it('carries a one-sided category across at zero', () => {
    const transport = view.compare.rows.find((r) => r.category === 'Transportation')
    expect(transport).toEqual({ category: 'Transportation', current: 34.99, previous: 0 })
    const personal = view.compare.rows.find((r) => r.category === 'Personal Care')
    expect(personal).toEqual({ category: 'Personal Care', current: 0, previous: 21.19 })
  })

  it('rounds a floating-point sum to a real amount', () => {
    const pennies = [
      t(0.1, '2026-08-10', 'FOOD_AND_DRINK'),
      t(0.1, '2026-08-11', 'FOOD_AND_DRINK'),
      t(0.1, '2026-08-12', 'FOOD_AND_DRINK'),
    ]
    const v = trendsView(windows, pennies, ctx)
    expect(v.compare.rows.find((r) => r.category === 'Food & Drink')?.current).toBe(0.3)
  })
})

describe('each card names the month it actually shows', () => {
  it('names the finished month on the spending card', () => {
    expect(view.spend.label).toBe('Aug 2026')
  })

  it('names both months, latest first, on the comparison card', () => {
    expect(view.compare.label).toBe('Aug 2026 vs Jul 2026')
    expect(view.compare.currentLabel).toBe('Aug 2026')
    expect(view.compare.previousLabel).toBe('Jul 2026')
  })

  it('plots the finished month on the spending card, not the one before it', () => {
    const spend = byCategory(view.spend.rows)
    expect(spend['Food & Drink']).toBeCloseTo(461.54) // August; July is 64.20
    expect(spend['Personal Care']).toBeUndefined() // July-only category
  })
})

describe('capCategories', () => {
  const row = (category: string, current: number, previous: number) => ({ category, current, previous })

  it('returns everything and no Other when there is nothing to fold', () => {
    const rows = [row('A', 5, 4), row('B', 3, 2)]
    const { shown, other } = capCategories(rows)
    expect(shown).toEqual(rows)
    expect(other).toBeNull()
  })

  it('keeps exactly the limit and folds the rest', () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(`C${i}`, 10 - i, 0))
    const { shown, other } = capCategories(rows, 6)
    expect(shown.map((r) => r.category)).toEqual(['C0', 'C1', 'C2', 'C3', 'C4', 'C5'])
    expect(other!.category).toBe('Other')
  })

  // The assertion §9 names. Other is the remainder, both windows, or the chart lies about the size
  // of what it is hiding.
  it("Other's amounts are the sum of the folded rows, per window", () => {
    const rows = [
      row('A', 100, 90),
      row('B', 80, 70),
      row('C', 60, 50),
      row('D', 40, 30),
      row('E', 20, 10),
      row('F', 10, 5),
      row('G', 3, 2),
      row('H', 1, 1),
    ]
    const { other } = capCategories(rows, 6)
    expect(other!.current).toBe(4)
    expect(other!.previous).toBe(3)
  })

  // Deliberately NOT in sorted order, and long enough to fold. trendsView hands these over already
  // sorted by combined size; if this function re-sorted, it could pick a different top N than the
  // desktop chart draws and the two would hide different categories. The early-return path cannot
  // exercise that — this has to go through the slice.
  it('does not re-sort rows that arrive ordered', () => {
    const rows = [
      row('Big', 100, 0),
      row('Small', 1, 0),
      row('Mid', 50, 0),
      row('Tiny', 0.5, 0),
    ]
    const { shown, other } = capCategories(rows, 3)
    expect(shown.map((r) => r.category)).toEqual(['Big', 'Small', 'Mid'])
    expect(other!.current).toBe(0.5)
  })

  // Exactly at the limit folds nothing — an "Other" worth $0 is noise with a tap target on it.
  it('folds nothing when the row count equals the limit', () => {
    const rows = Array.from({ length: 6 }, (_, i) => row(`C${i}`, 1, 1))
    expect(capCategories(rows, 6).other).toBeNull()
  })

  // Float addition on money: 0.1 + 0.2 is 0.30000000000000004, and the chart would render it.
  it('rounds the folded sums to cents', () => {
    const rows = [
      ...Array.from({ length: 6 }, (_, i) => row(`C${i}`, 100 - i, 0)),
      row('X', 0.1, 0.1),
      row('Y', 0.2, 0.2),
    ]
    const { other } = capCategories(rows, 6)
    expect(other!.current).toBe(0.3)
    expect(other!.previous).toBe(0.3)
  })

  it('is safe on an empty list', () => {
    expect(capCategories([], 6)).toEqual({ shown: [], other: null })
  })

  // The default is the number the phone layout was designed around (spec §5: "the top 6"), and
  // every other test here passes `limit` explicitly — so without this, changing the default is
  // invisible to the suite while changing what the phone shows.
  it('defaults to six', () => {
    const rows = Array.from({ length: 9 }, (_, i) => row(`C${i}`, 9 - i, 0))
    const { shown, other } = capCategories(rows)
    expect(shown).toHaveLength(6)
    expect(other!.category).toBe('Other')
  })
})
