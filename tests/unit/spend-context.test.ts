import { describe, it, expect } from 'vitest'
import { buildSpendContext } from '@/lib/spend-context'
import type { Category } from '@/lib/categories'

const categories: Category[] = [
  { id: '1', name: 'Food & Drink', pfc_primary: 'FOOD_AND_DRINK', sort_order: 1 },
  { id: '2', name: 'Income', pfc_primary: 'INCOME', sort_order: 2 },
]

describe('buildSpendContext', () => {
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
