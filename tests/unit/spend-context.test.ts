import { describe, it, expect } from 'vitest'
import { buildSpendContext } from '@/lib/spend-context'
import { bankCategory, kindOf, resolveCategory } from '@/lib/category-rules'
import type { Category } from '@/lib/categories'
import { DEFAULTS, GROCERY, rule, testData } from './helpers/category-context'

const categories: Category[] = [
  { id: '1', name: 'Income', pfc_primary: 'INCOME', sort_order: 0 },
  { id: '2', name: 'Transfer In', pfc_primary: 'TRANSFER_IN', sort_order: 1 },
  { id: '3', name: 'Food & Drink', pfc_primary: 'FOOD_AND_DRINK', sort_order: 2 },
  { id: '4', name: 'Reimbursable-ish custom', pfc_primary: null, sort_order: 3 },
]

describe('buildSpendContext', () => {
  // Ported from the pre-refactor suite (arguments updated to { data, txns }; the exclusion-set
  // assertions now go through the public bankCategory/kindOf, with the same meaning) — buildSpendContext is what every one of the five money surfaces calls, and nothing
  // else in the suite constructs a SpendContext through it: tests/unit/budget.test.ts and
  // tests/unit/dashboard.test.ts both hand-build a SpendContext object literal, which exercises the
  // arithmetic that CONSUMES the context but not the wiring inside buildSpendContext itself.
  it('derives the pfc map, the exclusion sets and the reimbursable totals in one pass', () => {
    const ctx = buildSpendContext({
      data: testData(categories),
      txns: [{ id: 't1', amount: 1000, reimbursable_amount: 500 }],
    })
    expect(bankCategory({ pfc_primary: 'FOOD_AND_DRINK' }, ctx).name).toBe('Food & Drink')
    expect(kindOf('Income', ctx)).toBe('income')
    expect(kindOf('Transfer In', ctx)).toBe('transfer')
    expect(kindOf('Food & Drink', ctx)).toBe('spending')
    expect(ctx.reimbursedByTxn['t1']).toBeCloseTo(500)
  })

  it('builds a usable context with no reimbursable transactions', () => {
    const ctx = buildSpendContext({ data: testData(categories), txns: [] })
    expect(ctx.reimbursedByTxn).toEqual({})
    expect(bankCategory({ pfc_primary: 'INCOME' }, ctx).name).toBe('Income')
  })

  // A custom category (pfc_primary null) is spending — it is neither income nor a transfer.
  it('treats a custom category as spending', () => {
    const ctx = buildSpendContext({ data: testData(categories), txns: [] })
    expect(kindOf('Reimbursable-ish custom', ctx)).toBe('spending')
  })

  // The context is built from the SAME rows the surface renders, so a page cannot fetch its
  // transactions and then forget to fetch what is reimbursable about them — they arrive together.
  it('builds the reimbursable map from the transactions themselves', () => {
    const ctx = buildSpendContext({
      data: testData(categories),
      txns: [
        { id: 't1', amount: 105, reimbursable_amount: 105 },
        { id: 't2', amount: 17.16, reimbursable_amount: null },
      ],
    })
    expect(ctx.reimbursedByTxn).toEqual({ t1: 105 })
  })

  it('carries an empty map when nothing is marked', () => {
    const ctx = buildSpendContext({ data: testData(categories), txns: [{ id: 't1', amount: 40, reimbursable_amount: null }] })
    expect(ctx.reimbursedByTxn).toEqual({})
  })

  // #28: the context a money page builds carries the rules, not just the categories.
  it('resolves a rule through a built SpendContext', () => {
    const ctx = buildSpendContext({
      data: testData(DEFAULTS, [rule('Safeway', GROCERY.id)]),
      txns: [{ id: 't1', amount: 50, reimbursable_amount: 20 }],
    })
    const safeway = { user_category: null, pfc_primary: 'FOOD_AND_DRINK', pfc_detailed: null, merchant_name: 'Safeway' }
    expect(resolveCategory(safeway, ctx).name).toBe('Grocery')
    expect(ctx.reimbursedByTxn).toEqual({ t1: 20 })
  })
})
