import { describe, it, expect } from 'vitest'
import { filterByCategory, filterByFlow, activityItem } from '@/lib/category-views'
import { spendByCategory } from '@/lib/budget'
import { monthlyFlows } from '@/lib/dashboard'
import { spendableAmount } from '@/lib/reimbursements'
import { buildSpendContext } from '@/lib/spend-context'
import { kindOf } from '@/lib/category-rules'
import { DEFAULTS, GROCERY, rule, testData } from './helpers/category-context'

// #28 spec §7.2. These used to sit inline in pages, where nothing tested them. The parity tests
// run the real functions against each other: a Breakdown row and the list it opens must add up.
const r = (id: string, month: string, merchant_name: string | null, amount: number, pfc_primary: string | null, over: Record<string, unknown> = {}) => ({
  id, date: `${month}-10`, amount, merchant_name, user_category: null as string | null, pfc_primary,
  pfc_detailed: null as string | null, reimbursable_amount: null as number | null, ...over,
})
const ROWS = [
  r('a', '2026-08', 'Safeway', 50, 'FOOD_AND_DRINK'),
  r('b', '2026-08', 'Safeway', -10, 'FOOD_AND_DRINK'),
  r('c', '2026-09', 'Safeway', 70, 'FOOD_AND_DRINK'),
  r('d', '2026-09', 'Starbucks', 6, 'FOOD_AND_DRINK'),
  r('e', '2026-09', 'Acme Payroll', -3000, 'INCOME'),
  r('f', '2026-09', 'Savings', 500, 'TRANSFER_OUT'),
  // An unpicked card payment: Loan Payments by its primary, but in no total and no drill-down.
  r('g', '2026-09', null, 7866.69, 'LOAN_PAYMENTS', { pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' }),
  r('h', '2026-09', 'Mortgage Co', 2100, 'LOAN_PAYMENTS'),
  r('i', '2026-09', 'Safeway', 12, 'FOOD_AND_DRINK', { user_category: 'Travel' }),
  r('j', '2026-09', 'Rental', 400, 'TRAVEL', { reimbursable_amount: 400 }),
]
const MONTHS = ['2026-08', '2026-09']
const data = testData(DEFAULTS, [rule('Safeway', GROCERY.id)])
const ctx = buildSpendContext({ data, txns: ROWS })
const inMonth = (m: string) => ROWS.filter((t) => t.date.startsWith(m))
const sum = (rows: typeof ROWS) => rows.reduce((s, t) => s + spendableAmount(t, ctx.reimbursedByTxn), 0)

describe('filterByCategory', () => {
  it('adds up to spendByCategory for every spending category and month', () => {
    for (const m of MONTHS) {
      const byCat = spendByCategory(inMonth(m), ctx)
      for (const c of DEFAULTS.filter((c) => kindOf(c.name, ctx) === 'spending')) {
        expect(sum(filterByCategory(inMonth(m), c.name, ctx)), `${c.name} ${m}`).toBeCloseTo(byCat[c.name] ?? 0, 2)
      }
    }
  })

  it('adds up to monthlyFlows income over the income categories', () => {
    const flows = monthlyFlows(ROWS, ctx, MONTHS.map((key) => ({ key, label: key })))
    for (const [i, m] of MONTHS.entries()) {
      const incomeCats = DEFAULTS.filter((c) => kindOf(c.name, ctx) === 'income')
      const total = incomeCats.reduce(
        (s, c) => s - sum(filterByCategory(inMonth(m), c.name, ctx).filter((t) => spendableAmount(t, ctx.reimbursedByTxn) < 0)),
        0
      )
      expect(total).toBeCloseTo(flows[i].income, 2)
    }
  })

  it('leaves the unpicked card payment out of Loan Payments, and keeps the mortgage', () => {
    expect(filterByCategory(ROWS, 'Loan Payments', ctx).map((t) => t.id)).toEqual(['h'])
  })

  it('lists Safeway under Grocery through its rule, and a picked Safeway row under its pick', () => {
    expect(filterByCategory(ROWS, 'Grocery', ctx).map((t) => t.id)).toEqual(['a', 'b', 'c'])
    expect(filterByCategory(ROWS, 'Travel', ctx).map((t) => t.id)).toEqual(['i', 'j'])
  })
})

describe('filterByFlow', () => {
  it('returns the same rows with and without a Safeway → Grocery rule', () => {
    const plain = buildSpendContext({ data: testData(DEFAULTS), txns: ROWS })
    for (const flow of ['in', 'out'] as const) {
      expect(filterByFlow(ROWS, flow, ctx).map((t) => t.id)).toEqual(filterByFlow(ROWS, flow, plain).map((t) => t.id))
    }
  })

  it('splits as monthlyFlows does: no transfers, no card payments, no fully reimbursed rows', () => {
    expect(filterByFlow(ROWS, 'in', ctx).map((t) => t.id)).toEqual(['e'])
    expect(filterByFlow(ROWS, 'out', ctx).map((t) => t.id)).toEqual(['a', 'b', 'c', 'd', 'h', 'i'])
  })

  // monthlyFlows counts an income-category outflow (a payroll clawback) in neither income nor
  // spending, so neither list may hold it. Kept out of ROWS so the parity fixture stays as it is.
  it('lists an income-category outflow under neither Money in nor Money out', () => {
    const clawback = [r('k', '2026-09', 'Acme Payroll', 200, 'INCOME')]
    const kctx = buildSpendContext({ data, txns: clawback })
    expect(filterByFlow(clawback, 'in', kctx)).toEqual([])
    expect(filterByFlow(clawback, 'out', kctx)).toEqual([])
  })
})

describe('activityItem', () => {
  it('labels a Safeway row Grocery', () => {
    const t = { ...ROWS[2], name: 'SAFEWAY #123' }
    expect(activityItem(t, ctx)).toMatchObject({ id: 'c', date: '2026-09-10', category: 'Grocery' })
  })
})
