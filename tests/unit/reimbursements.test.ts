import { describe, it, expect } from 'vitest'
import {
  reimbursedByTxn,
  spendableAmount,
  writeOffsAsTxns,
  claimTotals,
  allocateWriteOff,
  type Split,
  type Claim,
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

describe('claimTotals', () => {
  const open: Claim = { id: 'c1', name: 'Vacation rental', written_off_on: null }

  // The scenario from the spec: $1,000 rental, $250 each from three people, Dave has paid.
  const splits: Split[] = [
    { transaction_id: 'rental', claim_id: 'c1', owed_by: 'Dave', amount: 250 },
    { transaction_id: 'rental', claim_id: 'c1', owed_by: 'Sam', amount: 250 },
    { transaction_id: 'rental', claim_id: 'c1', owed_by: 'Priya', amount: 250 },
    { transaction_id: 'dave-repay', claim_id: 'c1', owed_by: 'Dave', amount: 250 },
  ]
  const amountById = { rental: 1000, 'dave-repay': -250 }

  it('splits owed from returned by the sign of the transaction', () => {
    const r = claimTotals(open, splits, amountById)
    expect(r.owed).toBeCloseTo(750)
    expect(r.returned).toBeCloseTo(250)
    expect(r.outstanding).toBeCloseTo(500)
  })

  it('breaks the outstanding amount down per person', () => {
    const r = claimTotals(open, splits, amountById)
    const byName = Object.fromEntries(r.byPerson.map((p) => [p.owedBy, p]))
    expect(byName['Dave'].outstanding).toBeCloseTo(0)
    expect(byName['Sam'].outstanding).toBeCloseTo(250)
    expect(byName['Priya'].outstanding).toBeCloseTo(250)
  })

  it('sorts the biggest outstanding debtor first', () => {
    const r = claimTotals(open, splits, amountById)
    expect(r.byPerson[r.byPerson.length - 1].owedBy).toBe('Dave') // fully paid, so last
  })

  // "Settled" is DERIVED, never stored — there is no status column to drift.
  it('derives settled from the totals, not from a stored field', () => {
    const paid: Split[] = [
      { transaction_id: 'rental', claim_id: 'c1', owed_by: 'Dave', amount: 250 },
      { transaction_id: 'dave-repay', claim_id: 'c1', owed_by: 'Dave', amount: 250 },
    ]
    const r = claimTotals(open, paid, { rental: 1000, 'dave-repay': -250 })
    expect(r.outstanding).toBe(0)
    expect(r.settled).toBe(true)
    expect(r.writtenOff).toBe(false)
  })

  it('is not settled while anything is outstanding', () => {
    expect(claimTotals(open, splits, amountById).settled).toBe(false)
  })

  it('reports a written-off claim as written off', () => {
    const written: Claim = { id: 'c1', name: 'Q3 work travel', written_off_on: '2026-11-03' }
    const r = claimTotals(written, splits, amountById)
    expect(r.writtenOff).toBe(true)
  })

  it('groups splits with no person under Unattributed', () => {
    const r = claimTotals(
      open,
      [{ transaction_id: 'rental', claim_id: 'c1', owed_by: null, amount: 400 }],
      { rental: 500 }
    )
    expect(r.byPerson).toHaveLength(1)
    expect(r.byPerson[0].owedBy).toBe('Unattributed')
    expect(r.byPerson[0].outstanding).toBeCloseTo(400)
  })

  it('is all zeroes for a claim with no splits', () => {
    const r = claimTotals(open, [], {})
    expect(r).toMatchObject({ owed: 0, returned: 0, outstanding: 0, byPerson: [] })
  })

  // A split whose transaction is missing from the map (deleted, or outside the fetched window)
  // must be skipped entirely, since without the guard it would silently be treated as an expense.
  it('ignores a split whose transaction is unknown', () => {
    const r = claimTotals(
      open,
      [{ transaction_id: 'ghost', claim_id: 'c1', owed_by: 'Dave', amount: 250 }],
      {}
    )
    expect(r.owed).toBe(0)
    expect(r.returned).toBe(0)
    expect(r.byPerson).toHaveLength(0) // No person bucket created before the continue
  })

  // Proves the guard is strict (=== undefined), not falsy: a transaction with amount 0 exists
  // and should be processed (0 is not < 0, so it counts as owed), unlike an undefined amount.
  it('processes a transaction with amount 0 as an outflow', () => {
    const r = claimTotals(
      open,
      [{ transaction_id: 'zero-expense', claim_id: 'c1', owed_by: 'Dave', amount: 50 }],
      { 'zero-expense': 0 }
    )
    expect(r.owed).toBeCloseTo(50) // Processed as an outflow, not skipped
    expect(r.returned).toBe(0)
    expect(r.byPerson).toHaveLength(1)
    expect(r.byPerson[0].owedBy).toBe('Dave')
    expect(r.byPerson[0].owed).toBeCloseTo(50)
  })
})

describe('allocateWriteOff', () => {
  const open: Claim = { id: 'c1', name: 'Bourbon trail trip', written_off_on: null }

  it('writes off the unreturned amount, dated the write-off day', () => {
    const splits: Split[] = [
      { transaction_id: 'dinner', claim_id: 'c1', owed_by: 'Dave', amount: 840 },
      { transaction_id: 'repay', claim_id: 'c1', owed_by: 'Dave', amount: 300 },
    ]
    const r = allocateWriteOff(
      open,
      splits,
      { dinner: 'Food & Drink', repay: 'Transfer In' },
      { dinner: 900, repay: -300 },
      '2026-11-03'
    )
    expect(r).toHaveLength(1)
    expect(r[0].amount).toBeCloseTo(540) // 840 owed - 300 returned
    expect(r[0].category).toBe('Food & Drink')
    expect(r[0].date).toBe('2026-11-03') // NOT the original expense date
    expect(r[0].claim_id).toBe('c1')
  })

  it('allocates pro-rata across the categories the expenses came from', () => {
    const splits: Split[] = [
      { transaction_id: 'hotel', claim_id: 'c1', owed_by: 'Sam', amount: 750 },
      { transaction_id: 'dinner', claim_id: 'c1', owed_by: 'Sam', amount: 250 },
    ]
    const r = allocateWriteOff(
      open,
      splits,
      { hotel: 'Travel', dinner: 'Food & Drink' },
      { hotel: 1000, dinner: 300 },
      '2026-11-03'
    )
    const byCat = Object.fromEntries(r.map((w) => [w.category, w.amount]))
    // $1,000 owed, nothing returned: Travel 75%, Food & Drink 25%.
    expect(byCat['Travel']).toBeCloseTo(750)
    expect(byCat['Food & Drink']).toBeCloseTo(250)
  })

  it('allocates a partial repayment pro-rata too', () => {
    const splits: Split[] = [
      { transaction_id: 'hotel', claim_id: 'c1', owed_by: 'Sam', amount: 750 },
      { transaction_id: 'dinner', claim_id: 'c1', owed_by: 'Sam', amount: 250 },
      { transaction_id: 'repay', claim_id: 'c1', owed_by: 'Sam', amount: 400 },
    ]
    const r = allocateWriteOff(
      open,
      splits,
      { hotel: 'Travel', dinner: 'Food & Drink', repay: 'Transfer In' },
      { hotel: 1000, dinner: 300, repay: -400 },
      '2026-11-03'
    )
    const byCat = Object.fromEntries(r.map((w) => [w.category, w.amount]))
    // $600 unreturned, split 75/25.
    expect(byCat['Travel']).toBeCloseTo(450)
    expect(byCat['Food & Drink']).toBeCloseTo(150)
    expect(r.reduce((s, w) => s + w.amount, 0)).toBeCloseTo(600)
  })

  it('merges two expenses in the same category into one row', () => {
    const splits: Split[] = [
      { transaction_id: 'lunch', claim_id: 'c1', owed_by: 'Sam', amount: 100 },
      { transaction_id: 'dinner', claim_id: 'c1', owed_by: 'Sam', amount: 300 },
    ]
    const r = allocateWriteOff(
      open,
      splits,
      { lunch: 'Food & Drink', dinner: 'Food & Drink' },
      { lunch: 120, dinner: 350 },
      '2026-11-03'
    )
    expect(r).toHaveLength(1)
    expect(r[0].amount).toBeCloseTo(400)
  })

  it('writes off nothing for a fully repaid claim', () => {
    const splits: Split[] = [
      { transaction_id: 'dinner', claim_id: 'c1', owed_by: 'Dave', amount: 250 },
      { transaction_id: 'repay', claim_id: 'c1', owed_by: 'Dave', amount: 250 },
    ]
    expect(
      allocateWriteOff(
        open,
        splits,
        { dinner: 'Food & Drink', repay: 'Transfer In' },
        { dinner: 300, repay: -250 },
        '2026-11-03'
      )
    ).toEqual([])
  })

  it('writes off nothing for a claim with no splits', () => {
    expect(allocateWriteOff(open, [], {}, {}, '2026-11-03')).toEqual([])
  })

  // Rounding must not lose or invent a cent: three equal shares of $100.01 do not divide evenly, so
  // this pins the residual-cent behaviour. The rows must sum to the outstanding amount EXACTLY.
  it('makes the rows sum to the outstanding amount despite rounding', () => {
    const splits: Split[] = [
      { transaction_id: 'a', claim_id: 'c1', owed_by: null, amount: 100 },
      { transaction_id: 'b', claim_id: 'c1', owed_by: null, amount: 100 },
      { transaction_id: 'c', claim_id: 'c1', owed_by: null, amount: 100 },
      // $199.99 came back, leaving $100.01 outstanding across three equal categories.
      { transaction_id: 'repay', claim_id: 'c1', owed_by: null, amount: 199.99 },
    ]
    const r = allocateWriteOff(
      open,
      splits,
      { a: 'Travel', b: 'Food & Drink', c: 'Entertainment', repay: 'Transfer In' },
      { a: 100, b: 100, c: 100, repay: -199.99 },
      '2026-11-03'
    )
    expect(r).toHaveLength(3)
    // 33.34 + 33.34 + 33.33 — the last row absorbs the residual cent.
    expect(r.reduce((s, w) => s + w.amount, 0)).toBeCloseTo(100.01, 2)
  })
})
