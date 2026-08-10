import { describe, it, expect } from 'vitest'
import { spendByCategory, budgetedSpend, progress, spendThisVsLast, monthKey } from '@/lib/budget'
import type { SpendContext } from '@/lib/spend-context'

const pfcMap: Record<string, string> = {
  FOOD_AND_DRINK: 'Food & Drink',
  TRANSPORTATION: 'Transportation',
  INCOME: 'Income',
  TRANSFER_OUT: 'Transfer Out',
  ENTERTAINMENT: 'Entertainment',
}
const nonSpending = new Set(['Income', 'Transfer In', 'Transfer Out'])

// A context with no reimbursables — the baseline every pre-existing test uses. These tests passing
// unchanged is the proof that an empty split map is a no-op.
const ctx = (
  over: Partial<SpendContext> = {},
  map: Record<string, string> = pfcMap
): SpendContext => ({
  pfcMap: map,
  nonSpending,
  transfers: new Set(['Transfer In', 'Transfer Out']),
  reimbursedByTxn: {},
  // These functions never read the write-offs — a surface concatenates them onto its transaction
  // list before calling (see withWriteOffs), so they arrive as ordinary rows.
  writeOffs: [],
  ...over,
})

let seq = 0
const t = (
  amount: number,
  date: string,
  pfc: string,
  override: string | null = null,
  pfc_detailed: string | null = null,
  id: string = `t${++seq}`
) => ({
  id,
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
      ctx()
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
      ctx({}, { ...pfcMap, LOAN_PAYMENTS: 'Loan Payments' })
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
      ctx({}, { ...pfcMap, TRAVEL: 'Travel' })
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
      ctx()
    )
    expect(r['Income']).toBeUndefined()
    expect(r['Transfer Out']).toBeUndefined()
    expect(r['Entertainment']).toBe(20)
  })

  it('honors a user re-categorization (by name)', () => {
    const r = spendByCategory(
      [t(12, '2026-07-10', 'FOOD_AND_DRINK', 'Entertainment')],
      ctx()
    )
    expect(r['Entertainment']).toBe(12)
    expect(r['Food & Drink']).toBeUndefined()
  })

  // #27: the $1,000 rental split three ways. Only the unsplit $250 is the user's spending.
  it('counts only the unsplit remainder of a reimbursable outflow', () => {
    const rental = t(1000, '2026-07-04', 'TRAVEL', null, null, 'rental')
    const r = spendByCategory(
      [rental],
      ctx({ reimbursedByTxn: { rental: 750 } }, { ...pfcMap, TRAVEL: 'Travel' })
    )
    expect(r['Travel']).toBeCloseTo(250)
  })

  // A repayment tagged to a claim is flow-neutral: it must NOT net the category down like a refund.
  it('ignores a fully tagged repayment inflow', () => {
    const rental = t(1000, '2026-07-04', 'TRAVEL', null, null, 'rental')
    const repay = t(-250, '2026-08-03', 'TRAVEL', null, null, 'repay')
    const r = spendByCategory(
      [rental, repay],
      ctx({ reimbursedByTxn: { rental: 750, repay: 250 } }, { ...pfcMap, TRAVEL: 'Travel' })
    )
    // 250 of real spending, and the repayment contributes nothing at all.
    expect(r['Travel']).toBeCloseTo(250)
  })

  // A written-off claim arrives as a synthesised transaction in its allocated category.
  it('counts a write-off as spending in its allocated category', () => {
    const r = spendByCategory(
      [
        {
          id: 'writeoff:c1:0',
          amount: 540,
          date: '2026-11-03',
          user_category: 'Food & Drink',
          pfc_primary: null,
          pfc_detailed: null,
        },
      ],
      ctx()
    )
    expect(r['Food & Drink']).toBeCloseTo(540)
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
  it('buckets by month (full period when throughDay covers the month)', () => {
    const r = spendThisVsLast(
      [t(10, '2026-07-05', 'FOOD_AND_DRINK'), t(30, '2026-06-20', 'FOOD_AND_DRINK')],
      '2026-07',
      '2026-06',
      ctx(),
      31
    )
    expect(r.thisMonth['Food & Drink']).toBe(10)
    expect(r.lastMonth['Food & Drink']).toBe(30)
  })

  // The #9 fix: mid-month, last month must be capped at the same day so it's a fair comparison.
  it('caps last month at throughDay (apples-to-apples, not partial-vs-whole)', () => {
    const r = spendThisVsLast(
      [
        t(10, '2026-07-05', 'FOOD_AND_DRINK'), // this month, day 5
        t(30, '2026-06-05', 'FOOD_AND_DRINK'), // last month, day 5 — counts
        t(200, '2026-06-25', 'FOOD_AND_DRINK'), // last month, day 25 — excluded on the 10th
      ],
      '2026-07',
      '2026-06',
      ctx(),
      10 // "today" is the 10th
    )
    expect(r.thisMonth['Food & Drink']).toBe(10)
    expect(r.lastMonth['Food & Drink']).toBe(30) // the day-25 $200 is not yet "reached" this month
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
