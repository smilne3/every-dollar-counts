import { describe, it, expect } from 'vitest'
import {
  reimbursedByTxn,
  spendableAmount,
  writeOffsAsTxns,
  type Split,
} from '@/lib/reimbursements'

const split = (transaction_id: string, amount: number, owed_by: string | null = null): Split => ({
  transaction_id,
  claim_id: 'claim-1',
  owed_by,
  amount,
})

describe('reimbursedByTxn', () => {
  it('sums split amounts per transaction', () => {
    const r = reimbursedByTxn([
      split('t1', 250, 'Dave'),
      split('t1', 250, 'Sam'),
      split('t1', 250, 'Priya'),
      split('t2', 400),
    ])
    expect(r['t1']).toBeCloseTo(750)
    expect(r['t2']).toBeCloseTo(400)
  })

  it('is an empty map for no splits', () => {
    expect(reimbursedByTxn([])).toEqual({})
  })
})

describe('spendableAmount', () => {
  // The $1,000 rental split three ways: only the unsplit $250 is the user's spending.
  it('reduces an outflow by its reimbursable portion', () => {
    const r = reimbursedByTxn([split('t1', 250), split('t1', 250), split('t1', 250)])
    expect(spendableAmount({ id: 't1', amount: 1000 }, r)).toBeCloseTo(250)
  })

  // The $500 work dinner with $400 back: $100 is really the user's.
  it('handles a partial reimbursable', () => {
    const r = reimbursedByTxn([split('t1', 400)])
    expect(spendableAmount({ id: 't1', amount: 500 }, r)).toBeCloseTo(100)
  })

  it('zeroes a fully reimbursable outflow', () => {
    const r = reimbursedByTxn([split('t1', 500)])
    expect(spendableAmount({ id: 't1', amount: 500 }, r)).toBe(0)
  })

  // A repayment inflow is flow-NEUTRAL: not income, not negative spending.
  it('zeroes a fully tagged repayment inflow', () => {
    const r = reimbursedByTxn([split('t1', 250)])
    expect(spendableAmount({ id: 't1', amount: -250 }, r)).toBe(0)
  })

  // Dave rounds $250 up to $260. The tagged $250 is neutral; the $10 surplus stays an inflow and is
  // then treated exactly as any untagged $10 inflow of that category would be.
  it('leaves the surplus of an over-tagged repayment as an inflow', () => {
    const r = reimbursedByTxn([split('t1', 250)])
    expect(spendableAmount({ id: 't1', amount: -260 }, r)).toBeCloseTo(-10)
  })

  // This is what makes the whole refactor safe: no splits must be a perfect no-op.
  it('returns an untouched transaction unchanged', () => {
    expect(spendableAmount({ id: 't1', amount: 42.5 }, {})).toBe(42.5)
    expect(spendableAmount({ id: 't1', amount: -42.5 }, {})).toBe(-42.5)
  })

  it('never flips sign even if splits somehow exceed the amount', () => {
    const r = reimbursedByTxn([split('t1', 9999)])
    expect(spendableAmount({ id: 't1', amount: 100 }, r)).toBe(0)
    expect(spendableAmount({ id: 't1', amount: -100 }, r)).toBe(0)
  })
})

describe('writeOffsAsTxns', () => {
  it('maps a write-off into a transaction-shaped value in its stored category', () => {
    const r = writeOffsAsTxns([
      { claim_id: 'c1', category: 'Food & Drink', amount: 540, date: '2026-11-03' },
    ])
    expect(r).toHaveLength(1)
    expect(r[0].amount).toBeCloseTo(540)
    expect(r[0].date).toBe('2026-11-03')
    // user_category is how effectiveCategory picks it up, with no PFC mapping involved.
    expect(r[0].user_category).toBe('Food & Drink')
    expect(r[0].pfc_primary).toBeNull()
  })

  it('gives each write-off an id that can never collide with a real transaction id', () => {
    const r = writeOffsAsTxns([
      { claim_id: 'c1', category: 'Travel', amount: 100, date: '2026-11-03' },
      { claim_id: 'c1', category: 'Food & Drink', amount: 50, date: '2026-11-03' },
    ])
    const ids = r.map((x) => x.id)
    expect(new Set(ids).size).toBe(2)
    // Real transaction ids are uuids, so a prefixed id cannot pick up a real split.
    for (const id of ids) expect(id.startsWith('writeoff:')).toBe(true)
  })
})
