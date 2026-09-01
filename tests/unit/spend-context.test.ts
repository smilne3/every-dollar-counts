import { describe, it, expect } from 'vitest'
import { buildSpendContext } from '@/lib/spend-context'
import type { Category } from '@/lib/categories'

const categories: Category[] = [
  { id: '1', name: 'Income', pfc_primary: 'INCOME', sort_order: 0 },
  { id: '2', name: 'Transfer In', pfc_primary: 'TRANSFER_IN', sort_order: 1 },
  { id: '3', name: 'Food & Drink', pfc_primary: 'FOOD_AND_DRINK', sort_order: 2 },
  { id: '4', name: 'Reimbursable-ish custom', pfc_primary: null, sort_order: 3 },
]

describe('buildSpendContext', () => {
  // Ported from the pre-refactor suite (arguments updated to { categories, txns }, assertions
  // unchanged) — buildSpendContext is what every one of the five money surfaces calls, and nothing
  // else in the suite constructs a SpendContext through it: tests/unit/budget.test.ts and
  // tests/unit/dashboard.test.ts both hand-build a SpendContext object literal, which exercises the
  // arithmetic that CONSUMES the context but not the wiring inside buildSpendContext itself.
  it('derives the pfc map, the exclusion sets and the reimbursable totals in one pass', () => {
    const ctx = buildSpendContext({
      categories,
      txns: [{ id: 't1', amount: 1000, reimbursable_amount: 500 }],
    })
    expect(ctx.pfcMap['FOOD_AND_DRINK']).toBe('Food & Drink')
    expect(ctx.nonSpending.has('Income')).toBe(true)
    expect(ctx.nonSpending.has('Transfer In')).toBe(true)
    expect(ctx.nonSpending.has('Food & Drink')).toBe(false)
    expect(ctx.transfers.has('Transfer In')).toBe(true)
    expect(ctx.transfers.has('Income')).toBe(false)
    expect(ctx.reimbursedByTxn['t1']).toBeCloseTo(500)
  })

  it('builds a usable context with no reimbursable transactions', () => {
    const ctx = buildSpendContext({ categories, txns: [] })
    expect(ctx.reimbursedByTxn).toEqual({})
    expect(ctx.pfcMap['INCOME']).toBe('Income')
  })

  // A custom category (pfc_primary null) is spending — it is neither income nor a transfer.
  it('treats a custom category as spending', () => {
    const ctx = buildSpendContext({ categories, txns: [] })
    expect(ctx.nonSpending.has('Reimbursable-ish custom')).toBe(false)
    expect(ctx.transfers.has('Reimbursable-ish custom')).toBe(false)
  })

  // The context is built from the SAME rows the surface renders, so a page cannot fetch its
  // transactions and then forget to fetch what is reimbursable about them — they arrive together.
  it('builds the reimbursable map from the transactions themselves', () => {
    const ctx = buildSpendContext({
      categories,
      txns: [
        { id: 't1', amount: 105, reimbursable_amount: 105 },
        { id: 't2', amount: 17.16, reimbursable_amount: null },
      ],
    })
    expect(ctx.reimbursedByTxn).toEqual({ t1: 105 })
  })

  it('carries an empty map when nothing is marked', () => {
    const ctx = buildSpendContext({ categories, txns: [{ id: 't1', amount: 40, reimbursable_amount: null }] })
    expect(ctx.reimbursedByTxn).toEqual({})
  })
})
