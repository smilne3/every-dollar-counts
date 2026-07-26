import { describe, it, expect } from 'vitest'
import { spendByCategory, budgetedSpend, progress, spendThisVsLast, monthKey } from '@/lib/budget'

const pfcMap: Record<string, string> = {
  FOOD_AND_DRINK: 'Food & Drink',
  TRANSPORTATION: 'Transportation',
  INCOME: 'Income',
  TRANSFER_OUT: 'Transfer Out',
  ENTERTAINMENT: 'Entertainment',
}
const nonSpending = new Set(['Income', 'Transfer In', 'Transfer Out'])

const t = (
  amount: number,
  date: string,
  pfc: string,
  override: string | null = null,
  pfc_detailed: string | null = null
) => ({
  amount,
  date,
  pfc_primary: pfc,
  pfc_detailed,
  user_category: override,
})

describe('spendByCategory', () => {
  it('sums outflows per effective category name', () => {
    const r = spendByCategory(
      [
        t(12, '2026-07-10', 'FOOD_AND_DRINK'),
        t(4.33, '2026-07-10', 'FOOD_AND_DRINK'),
        t(5.4, '2026-07-13', 'TRANSPORTATION'),
      ],
      pfcMap,
      nonSpending
    )
    expect(r['Food & Drink']).toBeCloseTo(16.33)
    expect(r['Transportation']).toBeCloseTo(5.4)
  })

  // Credit-card payments are internal transfers (paying off already-counted purchases). They carry
  // pfc_primary=LOAN_PAYMENTS, so the name-based exclusion misses them; they must be excluded by
  // detailed category. A mortgage payment, by contrast, is real spending and stays.
  it('excludes credit-card payments but keeps genuine loan payments', () => {
    const r = spendByCategory(
      [
        t(8930.72, '2026-07-10', 'LOAN_PAYMENTS', null, 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT'),
        t(493.75, '2026-07-11', 'LOAN_PAYMENTS', null, 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT'),
        t(3929.35, '2026-07-01', 'LOAN_PAYMENTS', null, 'LOAN_PAYMENTS_MORTGAGE_PAYMENT'),
      ],
      { ...pfcMap, LOAN_PAYMENTS: 'Loan Payments' },
      nonSpending
    )
    // only the mortgage remains under Loan Payments; the two card payments are gone
    expect(r['Loan Payments']).toBeCloseTo(3929.35)
  })

  // A refund (inflow in a spending category) must NET DOWN that category, not be ignored.
  it('nets refunds against their spending category', () => {
    const r = spendByCategory(
      [
        t(800, '2026-07-04', 'TRAVEL'),
        t(-500, '2026-07-20', 'TRAVEL'), // refund
      ],
      { ...pfcMap, TRAVEL: 'Travel' },
      nonSpending
    )
    expect(r['Travel']).toBeCloseTo(300)
  })

  it('ignores inflows and income/transfers', () => {
    const r = spendByCategory(
      [
        t(-500, '2026-07-11', 'INCOME'),
        t(1000, '2026-07-12', 'TRANSFER_OUT'),
        t(20, '2026-07-12', 'ENTERTAINMENT'),
      ],
      pfcMap,
      nonSpending
    )
    expect(r['Income']).toBeUndefined()
    expect(r['Transfer Out']).toBeUndefined()
    expect(r['Entertainment']).toBe(20)
  })

  it('honors a user re-categorization (by name)', () => {
    const r = spendByCategory(
      [t(12, '2026-07-10', 'FOOD_AND_DRINK', 'Entertainment')],
      pfcMap,
      nonSpending
    )
    expect(r['Entertainment']).toBe(12)
    expect(r['Food & Drink']).toBeUndefined()
  })
})

describe('progress', () => {
  it('clamps ratio to [0,1] and flags over-budget', () => {
    expect(progress(50, 100)).toEqual({ ratio: 0.5, over: false })
    expect(progress(150, 100)).toEqual({ ratio: 1, over: true })
    expect(progress(10, 0)).toEqual({ ratio: 0, over: true })
  })
})

describe('spendThisVsLast', () => {
  it('buckets by month', () => {
    const r = spendThisVsLast(
      [t(10, '2026-07-05', 'FOOD_AND_DRINK'), t(30, '2026-06-20', 'FOOD_AND_DRINK')],
      '2026-07',
      '2026-06',
      pfcMap,
      nonSpending
    )
    expect(r.thisMonth['Food & Drink']).toBe(10)
    expect(r.lastMonth['Food & Drink']).toBe(30)
  })
})

describe('monthKey', () => {
  it('extracts YYYY-MM', () => expect(monthKey('2026-07-13')).toBe('2026-07'))
})

describe('budgetedSpend', () => {
  it('counts only categories that have a limit set', () => {
    const spend = { 'Food & Drink': 16.33, Shopping: 89.4, 'Personal Care': 78.5 }
    // Budgeting one category must not drag the other categories' spend into the total.
    expect(budgetedSpend(spend, { 'Food & Drink': 200 })).toBe(16.33)
    expect(budgetedSpend(spend, { 'Food & Drink': 200, Shopping: 100 })).toBeCloseTo(105.73)
  })

  it('treats a budgeted category with no spend as zero', () => {
    expect(budgetedSpend({ Shopping: 50 }, { Travel: 300 })).toBe(0)
  })

  it('is zero when nothing is budgeted', () => {
    expect(budgetedSpend({ Shopping: 50 }, {})).toBe(0)
  })
})
