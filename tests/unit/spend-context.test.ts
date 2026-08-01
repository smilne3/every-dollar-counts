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
  it('derives the pfc map, the exclusion sets and the split totals in one pass', () => {
    const ctx = buildSpendContext({
      categories,
      splits: [
        { transaction_id: 't1', claim_id: 'c1', owed_by: 'Dave', amount: 250 },
        { transaction_id: 't1', claim_id: 'c1', owed_by: 'Sam', amount: 250 },
      ],
    })
    expect(ctx.pfcMap['FOOD_AND_DRINK']).toBe('Food & Drink')
    expect(ctx.nonSpending.has('Income')).toBe(true)
    expect(ctx.nonSpending.has('Transfer In')).toBe(true)
    expect(ctx.nonSpending.has('Food & Drink')).toBe(false)
    expect(ctx.transfers.has('Transfer In')).toBe(true)
    expect(ctx.transfers.has('Income')).toBe(false)
    expect(ctx.reimbursedByTxn['t1']).toBeCloseTo(500)
  })

  it('builds a usable context with no splits at all', () => {
    const ctx = buildSpendContext({ categories, splits: [] })
    expect(ctx.reimbursedByTxn).toEqual({})
    expect(ctx.pfcMap['INCOME']).toBe('Income')
  })

  // A custom category (pfc_primary null) is spending — it is neither income nor a transfer.
  it('treats a custom category as spending', () => {
    const ctx = buildSpendContext({ categories, splits: [] })
    expect(ctx.nonSpending.has('Reimbursable-ish custom')).toBe(false)
    expect(ctx.transfers.has('Reimbursable-ish custom')).toBe(false)
  })
})
