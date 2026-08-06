import { describe, it, expect } from 'vitest'
import { validateSplit, validateSplitDeletion } from '@/lib/split-validation'

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

describe('validateSplitDeletion', () => {
  // $600 owed split on a $1,000 outflow, then the claim is written off (freezing a $600
  // reimbursement_write_offs row). Deleting the split now would make the transaction net back to
  // its full $1,000 while the frozen $600 row still stands, double-recording spending in a month
  // that may already be closed. Refused regardless of what the remaining totals would look like.
  it('refuses deleting a split on a written-off claim', () => {
    const r = validateSplitDeletion({
      claimWrittenOff: true,
      remainingOwed: 0,
      remainingReturned: 0,
    })
    expect(r.ok).toBe(false)
  })

  // $500 owed split on outflow X, $500 repayment split on inflow Y. Deleting the owed split would
  // leave only the repayment behind: the claim would owe $0 but show $500 returned, so the $500
  // that genuinely arrived on Y would be counted as neither spending nor income.
  it('refuses deleting an owed split that would orphan a repayment', () => {
    const r = validateSplitDeletion({
      claimWrittenOff: false,
      remainingOwed: 0,
      remainingReturned: 500,
    })
    expect(r.ok).toBe(false)
  })

  // Two owed splits ($300, $200) and no repayments at all. Deleting one leaves the claim owing
  // $300 and returned $0 — nothing left to orphan.
  it('allows deleting a plain owed split with no repayments', () => {
    const r = validateSplitDeletion({
      claimWrittenOff: false,
      remainingOwed: 300,
      remainingReturned: 0,
    })
    expect(r.ok).toBe(true)
  })

  // $500 owed split on outflow X, $500 repayment split on inflow Y. Deleting the REPAYMENT split
  // leaves just the owed split: owed $500, returned $0. Removing a repayment can only lower
  // `returned`, so it can never orphan anything on its own.
  it('allows deleting a repayment split itself', () => {
    const r = validateSplitDeletion({
      claimWrittenOff: false,
      remainingOwed: 500,
      remainingReturned: 0,
    })
    expect(r.ok).toBe(true)
  })

  // Exactly settled (returned === owed) is not "over"-returned: the rule is a strict `>`, so a
  // claim left fully settled by the deletion is allowed, not rejected.
  it('allows a deletion that leaves the claim exactly settled', () => {
    const r = validateSplitDeletion({
      claimWrittenOff: false,
      remainingOwed: 500,
      remainingReturned: 500,
    })
    expect(r.ok).toBe(true)
  })
})
