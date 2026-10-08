import { describe, it, expect } from 'vitest'
import { filterByCategory, filterByFlow, activityItem, categoryUsage, deleteImpact } from '@/lib/category-views'
import { spendByCategory } from '@/lib/budget'
import { monthlyFlows } from '@/lib/dashboard'
import { spendableAmount } from '@/lib/reimbursements'
import { buildSpendContext } from '@/lib/spend-context'
import { kindOf } from '@/lib/category-rules'
import { DEFAULTS, GROCERY, cat, rule, testData } from './helpers/category-context'

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

describe('categoryUsage', () => {
  it("counts each category's rows exactly as its drill-down lists them", () => {
    const { categories } = categoryUsage(ROWS, data, new Set(['Grocery']))
    for (const c of DEFAULTS) {
      expect(categories[c.name].txns, c.name).toBe(filterByCategory(ROWS, c.name, ctx).length)
    }
    expect(categories.Grocery).toEqual({ txns: 3, hasBudget: true })
    expect(categories['Loan Payments'].txns).toBe(1) // the mortgage; the card payment is left out
  })

  it('counts, per rule, the rows it relabels, the hand picks, and every matching row', () => {
    const { rules } = categoryUsage(ROWS, data, new Set())
    expect(rules['r-safeway']).toEqual({ changed: 3, pickedByHand: 1, matching: 4 })
  })

  it('reports a rule with no current rows as matching nothing', () => {
    const d = testData(DEFAULTS, [rule('Gone Market', GROCERY.id)])
    expect(categoryUsage(ROWS, d, new Set()).rules['r-gone market']).toEqual({ changed: 0, pickedByHand: 0, matching: 0 })
  })
})

describe('deleteImpact', () => {
  it("counts a pick of the deleted category as moving to its merchant's rule", () => {
    const rows = [r('p', '2026-09', 'Safeway', 9, 'FOOD_AND_DRINK', { user_category: 'Travel' })]
    const d = testData(DEFAULTS, [rule('Safeway', GROCERY.id)])
    expect(deleteImpact(rows, d, 'c-Travel')).toMatchObject({ uncategorized: 0, moved: [{ name: 'Grocery', count: 1 }] })
  })

  it('never counts a pick of the deleted category as staying', () => {
    const rows = [r('p', '2026-09', 'Nobody', 9, 'TRAVEL', { user_category: 'Travel' })]
    expect(deleteImpact(rows, testData(DEFAULTS), 'c-Travel')).toMatchObject({ uncategorized: 1, moved: [] })
  })

  // Review Focus 5.
  it('counts rule-labelled rows as moving to their bank category', () => {
    expect(deleteImpact(ROWS, data, GROCERY.id)).toMatchObject({ uncategorized: 0, moved: [{ name: 'Food & Drink', count: 3 }], rulesRemoved: 1, toSpending: 0 })
  })

  it('counts rows that start counting as spending when Transfer Out is deleted', () => {
    expect(deleteImpact(ROWS, data, 'c-Transfer Out')).toMatchObject({ uncategorized: 1, toSpending: 1 })
  })

  // The delete clears the pick, so a picked card payment goes back to being an unpicked one: shown
  // as "Card payment" and in no total. It leaves the deleted category and joins no other.
  it('counts a picked card payment as moving nowhere once its pick is cleared', () => {
    const card = { pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' }
    const travel = [r('p', '2026-09', 'Chase', 500, 'LOAN_PAYMENTS', { ...card, user_category: 'Travel' })]
    expect(deleteImpact(travel, testData(DEFAULTS), 'c-Travel')).toMatchObject({ uncategorized: 0, moved: [], movedMore: 0, toSpending: 0 })
    // Out of Transfer Out into Loan Payments would count as starting to count as spending.
    const transfer = [r('q', '2026-09', 'Chase', 500, 'LOAN_PAYMENTS', { ...card, user_category: 'Transfer Out' })]
    expect(deleteImpact(transfer, testData(DEFAULTS), 'c-Transfer Out')).toMatchObject({ uncategorized: 0, moved: [], movedMore: 0, toSpending: 0 })
  })

  it('lists the top three destinations and counts the rest as rows', () => {
    const cats = [...DEFAULTS, cat('A'), cat('B'), cat('C'), cat('D')]
    const rows = ['A', 'A', 'A', 'B', 'B', 'C', 'D', 'D', 'D', 'D'].map((n, i) =>
      r(`x${i}`, '2026-09', `M${n}`, 1, 'GENERAL_MERCHANDISE', { user_category: 'Shopping' })
    )
    const d = testData(cats, ['A', 'B', 'C', 'D'].map((n) => rule(`M${n}`, `c-${n}`)))
    const impact = deleteImpact(rows, d, 'c-Shopping')
    expect(impact.moved).toEqual([{ name: 'D', count: 4 }, { name: 'A', count: 3 }, { name: 'B', count: 2 }])
    expect(impact.movedMore).toBe(1)
  })
})
