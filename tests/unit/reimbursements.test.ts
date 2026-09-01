import { describe, it, expect } from 'vitest'
import {
  spendableAmount,
  reimbursableByTxn,
  owedToYou,
  unreimbursedExpenses,
  type ReimbursableTxn,
  type DatedReimbursableTxn,
} from '@/lib/reimbursements'

const txn = (id: string, amount: number, reimbursable_amount: number | null = null): ReimbursableTxn => ({
  id,
  amount,
  reimbursable_amount,
})

describe('spendableAmount', () => {
  // The $1,000 rental, $750 marked reimbursable: only the unmarked $250 is the user's spending.
  it('reduces an outflow by its reimbursable portion', () => {
    const r = reimbursableByTxn([txn('t1', 1000, 750)])
    expect(spendableAmount({ id: 't1', amount: 1000 }, r)).toBeCloseTo(250)
  })

  // The $500 work dinner with $400 marked back: $100 is really the user's.
  it('handles a partial reimbursable', () => {
    const r = reimbursableByTxn([txn('t1', 500, 400)])
    expect(spendableAmount({ id: 't1', amount: 500 }, r)).toBeCloseTo(100)
  })

  it('zeroes a fully reimbursable outflow', () => {
    const r = reimbursableByTxn([txn('t1', 500, 500)])
    expect(spendableAmount({ id: 't1', amount: 500 }, r)).toBe(0)
  })

  // A repayment inflow is flow-NEUTRAL: not income, not negative spending.
  it('zeroes a fully tagged repayment inflow', () => {
    const r = reimbursableByTxn([txn('t1', -250, 250)])
    expect(spendableAmount({ id: 't1', amount: -250 }, r)).toBe(0)
  })

  // Marked $250 against a $260 repayment. The tagged $250 is neutral; the $10 surplus stays an
  // inflow and is then treated exactly as any untagged $10 inflow of that category would be.
  it('leaves the surplus of an over-tagged repayment as an inflow', () => {
    const r = reimbursableByTxn([txn('t1', -260, 250)])
    expect(spendableAmount({ id: 't1', amount: -260 }, r)).toBeCloseTo(-10)
  })

  // This is what makes the whole refactor safe: an unmarked transaction must be a perfect no-op.
  it('returns an untouched transaction unchanged', () => {
    expect(spendableAmount({ id: 't1', amount: 42.5 }, {})).toBe(42.5)
    expect(spendableAmount({ id: 't1', amount: -42.5 }, {})).toBe(-42.5)
  })

  it('never flips sign even if the marked amount somehow exceeds the transaction', () => {
    const r = reimbursableByTxn([txn('t1', 100, 9999)])
    expect(spendableAmount({ id: 't1', amount: 100 }, r)).toBe(0)
    expect(spendableAmount({ id: 't1', amount: -100 }, r)).toBe(0)
  })
})

describe('reimbursableByTxn', () => {
  it('maps marked transactions to their amount', () => {
    expect(reimbursableByTxn([txn('t1', 500, 500), txn('t2', 40)])).toEqual({ t1: 500 })
  })

  // An unmarked map must be a provable no-op for spendableAmount, which is what lets every money
  // surface run the same code path whether or not anything is marked.
  it('omits unmarked transactions entirely rather than storing zero', () => {
    expect(reimbursableByTxn([txn('t1', 40)])).toEqual({})
  })

  it('reads a numeric column that arrives as a string', () => {
    const fromDb = { id: 't1', amount: 500, reimbursable_amount: '250.50' as unknown as number }
    expect(reimbursableByTxn([fromDb])).toEqual({ t1: 250.5 })
  })
})

describe('owedToYou', () => {
  it('counts a marked outflow as money owed to you', () => {
    expect(owedToYou([txn('t1', 500, 500)])).toBeCloseTo(500)
  })

  // The sign of the TRANSACTION carries direction; reimbursable_amount is always a magnitude.
  it('subtracts a marked inflow, because that money already came back', () => {
    expect(owedToYou([txn('t1', 500, 500), txn('t2', -200, 200)])).toBeCloseTo(300)
  })

  it('counts only the marked portion of a partly-marked expense', () => {
    expect(owedToYou([txn('t1', 1000, 750)])).toBeCloseTo(750)
  })

  it('ignores unmarked transactions', () => {
    expect(owedToYou([txn('t1', 500), txn('t2', -2772.63)])).toBe(0)
  })

  // An over-repayment is a surplus inflow, not a debt you owe your employer. Without the clamp a
  // stray overpayment would quietly REDUCE net worth.
  it('never returns a negative when more came back than went out', () => {
    expect(owedToYou([txn('t1', 500, 500), txn('t2', -600, 600)])).toBe(0)
  })
})

const exp = (id: string, date: string, amount: number, marked: number): DatedReimbursableTxn => ({
  id,
  date,
  amount,
  reimbursable_amount: marked,
})
const dep = (id: string, date: string, amount: number, marked: number): DatedReimbursableTxn => ({
  id,
  date,
  amount: -amount,
  reimbursable_amount: marked,
})

describe('unreimbursedExpenses', () => {
  it('lists a marked expense with nothing paid back', () => {
    expect(unreimbursedExpenses([exp('t1', '2026-08-01', 105, 105)])).toEqual([
      { id: 't1', date: '2026-08-01', remaining: 105 },
    ])
  })

  // FIFO: deposits settle the OLDEST outstanding expenses first. This is what makes the view correct
  // without knowing which deposit paid which expense — the whole reason the model has no claims.
  it('settles the oldest expenses first', () => {
    const rows = unreimbursedExpenses([
      exp('t1', '2026-08-01', 100, 100),
      exp('t2', '2026-08-10', 105, 105),
      dep('d1', '2026-08-18', 100, 100),
    ])
    expect(rows).toEqual([{ id: 't2', date: '2026-08-10', remaining: 105 }])
  })

  it('reports the remainder of a partly-covered expense', () => {
    const rows = unreimbursedExpenses([
      exp('t1', '2026-08-01', 100, 100),
      dep('d1', '2026-08-18', 60, 60),
    ])
    expect(rows).toEqual([{ id: 't1', date: '2026-08-01', remaining: 40 }])
  })

  it('leaves nothing outstanding when the deposits cover everything', () => {
    expect(
      unreimbursedExpenses([exp('t1', '2026-08-01', 100, 100), dep('d1', '2026-08-18', 150, 150)])
    ).toEqual([])
  })

  // Timing is exactly what this must NOT depend on: submitted on the 15th, paid on the 20th, with an
  // expense on the 17th that was never claimed. A date rule drops that expense; FIFO on amounts keeps it.
  it('keeps an expense dated between a submission and its deposit', () => {
    const rows = unreimbursedExpenses([
      exp('t1', '2026-08-10', 100, 100),
      exp('t2', '2026-08-17', 45, 45),
      dep('d1', '2026-08-20', 100, 100),
    ])
    expect(rows).toEqual([{ id: 't2', date: '2026-08-17', remaining: 45 }])
  })

  it('ignores unmarked transactions in both directions', () => {
    const rows = unreimbursedExpenses([
      exp('t1', '2026-08-01', 100, 100),
      { id: 'salary', date: '2026-08-29', amount: -2772.63, reimbursable_amount: null },
      { id: 'coffee', date: '2026-08-02', amount: 17.16, reimbursable_amount: null },
    ])
    expect(rows).toEqual([{ id: 't1', date: '2026-08-01', remaining: 100 }])
  })

  it('drops an expense the deposits covered to the exact cent', () => {
    const rows = unreimbursedExpenses([
      exp('t1', '2026-08-01', 33.33, 33.33),
      dep('d1', '2026-08-18', 33.33, 33.33),
    ])
    // Boundary: pool == marked exactly. When a deposit covers an expense to the exact cent,
    // remaining becomes 0 and the expense vanishes from the outstanding list.
    expect(rows).toEqual([])
  })
})
