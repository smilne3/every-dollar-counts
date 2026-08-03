import { describe, it, expect } from 'vitest'
import {
  netWorth,
  cashOnHand,
  lastNMonths,
  monthlyFlows,
  sumManualAssets,
  type FlowTxn,
} from '@/lib/dashboard'

describe('netWorth', () => {
  it('sums assets minus liabilities across account types', () => {
    const accounts = [
      { type: 'depository', current_balance: 8000 },
      { type: 'investment', current_balance: 2000 },
      { type: 'other', current_balance: 100 },
      { type: 'credit', current_balance: 500 },
      { type: 'loan', current_balance: 10000 },
    ]
    // assets 10100 - liabilities 10500
    expect(netWorth(accounts)).toBe(-400)
  })

  it('treats null balances and unknown types as zero/ignored', () => {
    expect(netWorth([{ type: 'depository', current_balance: null }, { type: null, current_balance: 999 }])).toBe(0)
  })
})

describe('sumManualAssets', () => {
  it('sums values, treating null as zero', () => {
    expect(sumManualAssets([{ value: 500000 }, { value: null }, { value: 12000 }])).toBe(512000)
  })
  it('is zero for an empty list', () => {
    expect(sumManualAssets([])).toBe(0)
  })
})

describe('cashOnHand', () => {
  it('sums only depository balances', () => {
    const accounts = [
      { type: 'depository', current_balance: 1200 },
      { type: 'depository', current_balance: 300 },
      { type: 'investment', current_balance: 5000 },
      { type: 'credit', current_balance: 400 },
    ]
    expect(cashOnHand(accounts)).toBe(1500)
  })
})

describe('lastNMonths', () => {
  it('returns n chronological months ending at now', () => {
    const months = lastNMonths(new Date(2026, 6, 15), 6) // Jul 2026
    expect(months).toHaveLength(6)
    expect(months[0]).toEqual({ key: '2026-02', label: 'Feb' })
    expect(months[5]).toEqual({ key: '2026-07', label: 'Jul' })
  })

  it('wraps across a year boundary', () => {
    const months = lastNMonths(new Date(2026, 0, 10), 3) // Jan 2026
    expect(months.map((m) => m.key)).toEqual(['2025-11', '2025-12', '2026-01'])
    expect(months.map((m) => m.label)).toEqual(['Nov', 'Dec', 'Jan'])
  })
})

describe('monthlyFlows', () => {
  const pfcMap = {
    FOOD_AND_DRINK: 'Food & Drink',
    TRAVEL: 'Travel',
    INCOME: 'Income',
    TRANSFER_IN: 'Transfer In',
  }
  const ctx = (reimbursedByTxn: Record<string, number> = {}) => ({
    pfcMap,
    nonSpending: new Set(['Income', 'Transfer In']),
    transfers: new Set(['Transfer In']),
    reimbursedByTxn,
  })
  const months = [
    { key: '2026-06', label: 'Jun' },
    { key: '2026-07', label: 'Jul' },
  ]

  const txns: FlowTxn[] = [
    { id: 'f1', amount: 50, date: '2026-07-03', user_category: null, pfc_primary: 'FOOD_AND_DRINK', pfc_detailed: null },
    { id: 'f2', amount: -2000, date: '2026-07-05', user_category: null, pfc_primary: 'INCOME', pfc_detailed: null },
    { id: 'f3', amount: -500, date: '2026-07-06', user_category: null, pfc_primary: 'TRANSFER_IN', pfc_detailed: null },
    { id: 'f4', amount: 30, date: '2026-06-11', user_category: null, pfc_primary: 'FOOD_AND_DRINK', pfc_detailed: null },
    { id: 'f5', amount: 999, date: '2026-05-01', user_category: null, pfc_primary: 'FOOD_AND_DRINK', pfc_detailed: null }, // out of range
  ]

  it('counts paychecks as income but excludes transfers, and excludes both from spending', () => {
    const flows = monthlyFlows(txns, ctx(), months)
    expect(flows).toEqual([
      { key: '2026-06', label: 'Jun', spending: 30, income: 0 },
      { key: '2026-07', label: 'Jul', spending: 50, income: 2000 },
    ])
  })

  it('respects user_category overrides', () => {
    const overridden: FlowTxn[] = [
      { id: 'f6', amount: 40, date: '2026-07-02', user_category: 'Income', pfc_primary: 'FOOD_AND_DRINK', pfc_detailed: null },
    ]
    const flows = monthlyFlows(overridden, ctx(), months)
    // amount > 0 but category is 'Income' (excluded from spending) -> not counted
    expect(flows.find((f) => f.key === '2026-07')).toMatchObject({ spending: 0, income: 0 })
  })

  // A credit-card payment is an internal transfer: money leaves checking (looks like spending) and
  // arrives at the card (looks like income). Plaid tags both legs LOAN_PAYMENTS_CREDIT_CARD_PAYMENT.
  // Neither leg is real — the purchases were already counted as spending when made.
  it('excludes credit-card payments from BOTH spending and income', () => {
    const ccPay: FlowTxn[] = [
      // checking side: money out
      {
        id: 'cc1',
        amount: 900,
        date: '2026-07-10',
        user_category: null,
        pfc_primary: 'LOAN_PAYMENTS',
        pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT',
      },
      // card side: money in (payment arriving)
      {
        id: 'cc2',
        amount: -900,
        date: '2026-07-10',
        user_category: null,
        pfc_primary: 'LOAN_PAYMENTS',
        pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT',
      },
    ]
    const flows = monthlyFlows(ccPay, ctx(), months)
    expect(flows.find((f) => f.key === '2026-07')).toMatchObject({ spending: 0, income: 0 })
  })

  // A mortgage payment IS a real recurring outflow — it must still count as spending.
  it('still counts a mortgage payment as spending', () => {
    const mortgage: FlowTxn[] = [
      {
        id: 'mort1',
        amount: 1500,
        date: '2026-07-10',
        user_category: null,
        pfc_primary: 'LOAN_PAYMENTS',
        pfc_detailed: 'LOAN_PAYMENTS_MORTGAGE_PAYMENT',
      },
    ]
    const flows = monthlyFlows(mortgage, ctx(), months)
    expect(flows.find((f) => f.key === '2026-07')).toMatchObject({ spending: 1500, income: 0 })
  })

  // A refund is an inflow (amount < 0) whose category is a SPENDING category — e.g. a $500 airline
  // refund tagged Travel. It must REDUCE Travel spending, not count as income (the old bug) and not
  // vanish. A genuine paycheck (inflow in the Income category) still counts as income.
  it('nets a refund against its spending category instead of counting it as income', () => {
    const withRefund: FlowTxn[] = [
      { id: 'r1', amount: 800, date: '2026-07-04', user_category: null, pfc_primary: 'TRAVEL', pfc_detailed: null },
      { id: 'r2', amount: -500, date: '2026-07-20', user_category: null, pfc_primary: 'TRAVEL', pfc_detailed: null }, // refund
    ]
    const flows = monthlyFlows(withRefund, ctx(), months)
    // net Travel spend = 800 - 500 = 300; income unaffected
    expect(flows.find((f) => f.key === '2026-07')).toMatchObject({ spending: 300, income: 0 })
  })

  it('still counts a genuine paycheck (inflow in an income category) as income', () => {
    const paycheck: FlowTxn[] = [
      { id: 'p1', amount: -2000, date: '2026-07-05', user_category: null, pfc_primary: 'INCOME', pfc_detailed: null },
    ]
    const flows = monthlyFlows(paycheck, ctx(), months)
    expect(flows.find((f) => f.key === '2026-07')).toMatchObject({ spending: 0, income: 2000 })
  })

  // If the user deliberately recategorized a card payment, honor the override (existing contract).
  it('honors a user override on a credit-card payment', () => {
    const overridden: FlowTxn[] = [
      {
        id: 'o1',
        amount: 900,
        date: '2026-07-10',
        user_category: 'Food & Drink',
        pfc_primary: 'LOAN_PAYMENTS',
        pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT',
      },
    ]
    const flows = monthlyFlows(overridden, ctx(), months)
    expect(flows.find((f) => f.key === '2026-07')).toMatchObject({ spending: 900 })
  })

  it('counts only the unsplit remainder of a reimbursable outflow', () => {
    const flows = monthlyFlows(
      [
        {
          id: 'rental',
          amount: 1000,
          date: '2026-07-04',
          user_category: null,
          pfc_primary: 'TRAVEL',
          pfc_detailed: null,
        },
      ],
      ctx({ rental: 750 }),
      months
    )
    expect(flows[1].spending).toBeCloseTo(250)
  })

  // The cross-month case #27 exists to fix: fronting money in July and being repaid in August must
  // leave BOTH months undistorted — no July spike, and no negative August spending.
  it('leaves both months clean across a cross-month reimbursement', () => {
    const flows = monthlyFlows(
      [
        {
          id: 'flight',
          amount: 500,
          date: '2026-06-04',
          user_category: null,
          pfc_primary: 'TRAVEL',
          pfc_detailed: null,
        },
        {
          id: 'repay',
          amount: -500,
          date: '2026-07-03',
          user_category: null,
          pfc_primary: 'TRANSFER_IN',
          pfc_detailed: null,
        },
      ],
      ctx({ flight: 500, repay: 500 }),
      months
    )
    expect(flows[0].spending).toBe(0) // June: not a $500 spike
    expect(flows[1].spending).toBe(0) // July: not -$500
    expect(flows[1].income).toBe(0) // and the repayment is not income
  })
})
