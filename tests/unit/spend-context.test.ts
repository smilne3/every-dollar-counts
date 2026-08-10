import { describe, it, expect } from 'vitest'
import { buildSpendContext, withWriteOffs } from '@/lib/spend-context'
import type { Category } from '@/lib/categories'
import type { WriteOff } from '@/lib/reimbursements'

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
      writeOffs: [],
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
    const ctx = buildSpendContext({ categories, splits: [], writeOffs: [] })
    expect(ctx.reimbursedByTxn).toEqual({})
    expect(ctx.pfcMap['INCOME']).toBe('Income')
  })

  // A custom category (pfc_primary null) is spending — it is neither income nor a transfer.
  it('treats a custom category as spending', () => {
    const ctx = buildSpendContext({ categories, splits: [], writeOffs: [] })
    expect(ctx.nonSpending.has('Reimbursable-ish custom')).toBe(false)
    expect(ctx.transfers.has('Reimbursable-ish custom')).toBe(false)
  })

  // The write-offs are a context field precisely so a money surface cannot forget them: they arrive
  // with the same object as the split totals rather than being assembled per page.
  it('carries the write-offs for this surface date window', () => {
    const writeOffs: WriteOff[] = [
      { claim_id: 'c1', category: 'Travel', amount: 75, date: '2026-07-20' },
    ]
    const ctx = buildSpendContext({ categories, splits: [], writeOffs })
    expect(ctx.writeOffs).toEqual(writeOffs)
  })
})

describe('withWriteOffs', () => {
  const base = { categories, splits: [] }
  const txn = {
    id: 't1',
    amount: 120,
    date: '2026-07-02',
    user_category: null,
    pfc_primary: 'FOOD_AND_DRINK',
    pfc_detailed: null,
  }

  it('appends the context write-offs as transaction-shaped rows', () => {
    const ctx = buildSpendContext({
      ...base,
      writeOffs: [{ claim_id: 'c1', category: 'Travel', amount: 75, date: '2026-07-20' }],
    })
    const rows = withWriteOffs([txn], ctx)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toBe(txn)
    expect(rows[1]).toMatchObject({ amount: 75, date: '2026-07-20', user_category: 'Travel' })
  })

  // The no-op property the whole feature rests on: no write-offs means the list the surface computes
  // over is byte-identical to the one it had before write-offs existed.
  it('returns the transactions untouched when there are none', () => {
    const ctx = buildSpendContext({ ...base, writeOffs: [] })
    expect(withWriteOffs([txn], ctx)).toEqual([txn])
  })
})
