import { describe, it, expect } from 'vitest'
import { validateSplit } from '@/lib/split-validation'

describe('validateSplit', () => {
  it('accepts a split within the transaction amount', () => {
    expect(
      validateSplit({
        txnAmount: 1000,
        existingOnTxn: 500,
        proposed: 250,
        isRepayment: false,
        claimOutstanding: 0,
      })
    ).toEqual({ ok: true })
  })

  it('accepts splits that exactly consume the transaction', () => {
    expect(
      validateSplit({
        txnAmount: 500,
        existingOnTxn: 100,
        proposed: 400,
        isRepayment: false,
        claimOutstanding: 0,
      }).ok
    ).toBe(true)
  })

  it('rejects splits totalling more than the transaction', () => {
    const r = validateSplit({
      txnAmount: 1000,
      existingOnTxn: 800,
      proposed: 250,
      isRepayment: false,
      claimOutstanding: 0,
    })
    expect(r.ok).toBe(false)
  })

  it('rejects a zero or negative amount', () => {
    expect(
      validateSplit({ txnAmount: 1000, existingOnTxn: 0, proposed: 0, isRepayment: false, claimOutstanding: 0 }).ok
    ).toBe(false)
    expect(
      validateSplit({ txnAmount: 1000, existingOnTxn: 0, proposed: -50, isRepayment: false, claimOutstanding: 0 }).ok
    ).toBe(false)
  })

  // Dave rounds $250 up to $260: he may tag at most the $250 outstanding, and the surplus is left
  // untagged so it behaves as any untagged inflow of that category would.
  it('rejects a repayment split above the claim outstanding', () => {
    const r = validateSplit({
      txnAmount: -260,
      existingOnTxn: 0,
      proposed: 260,
      isRepayment: true,
      claimOutstanding: 250,
    })
    expect(r.ok).toBe(false)
  })

  it('accepts a repayment split up to the claim outstanding', () => {
    expect(
      validateSplit({
        txnAmount: -260,
        existingOnTxn: 0,
        proposed: 250,
        isRepayment: true,
        claimOutstanding: 250,
      }).ok
    ).toBe(true)
  })

  // The transaction-amount ceiling uses the ABSOLUTE value, since inflows are negative.
  it('measures an inflow against its absolute amount', () => {
    expect(
      validateSplit({
        txnAmount: -250,
        existingOnTxn: 0,
        proposed: 300,
        isRepayment: true,
        claimOutstanding: 9999,
      }).ok
    ).toBe(false)
  })
})
