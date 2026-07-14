import { describe, it, expect } from 'vitest'
import { netWorth, cashOnHand, lastNMonths, monthlyFlows, type FlowTxn } from '@/lib/dashboard'

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
    INCOME: 'Income',
    TRANSFER_IN: 'Transfer In',
  }
  const spendingExclude = new Set(['Income', 'Transfer In'])
  const incomeExclude = new Set(['Transfer In'])
  const months = [
    { key: '2026-06', label: 'Jun' },
    { key: '2026-07', label: 'Jul' },
  ]

  const txns: FlowTxn[] = [
    { amount: 50, date: '2026-07-03', user_category: null, pfc_primary: 'FOOD_AND_DRINK' },
    { amount: -2000, date: '2026-07-05', user_category: null, pfc_primary: 'INCOME' },
    { amount: -500, date: '2026-07-06', user_category: null, pfc_primary: 'TRANSFER_IN' },
    { amount: 30, date: '2026-06-11', user_category: null, pfc_primary: 'FOOD_AND_DRINK' },
    { amount: 999, date: '2026-05-01', user_category: null, pfc_primary: 'FOOD_AND_DRINK' }, // out of range
  ]

  it('counts paychecks as income but excludes transfers, and excludes both from spending', () => {
    const flows = monthlyFlows(txns, pfcMap, spendingExclude, incomeExclude, months)
    expect(flows).toEqual([
      { key: '2026-06', label: 'Jun', spending: 30, income: 0 },
      { key: '2026-07', label: 'Jul', spending: 50, income: 2000 },
    ])
  })

  it('respects user_category overrides', () => {
    const overridden: FlowTxn[] = [
      { amount: 40, date: '2026-07-02', user_category: 'Income', pfc_primary: 'FOOD_AND_DRINK' },
    ]
    const flows = monthlyFlows(overridden, pfcMap, spendingExclude, incomeExclude, months)
    // amount > 0 but category is 'Income' (excluded from spending) -> not counted
    expect(flows.find((f) => f.key === '2026-07')).toMatchObject({ spending: 0, income: 0 })
  })
})
