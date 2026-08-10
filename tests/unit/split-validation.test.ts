import { describe, it, expect } from 'vitest'
import { validateSplit, validateSplitDeletion, validateSplitTarget } from '@/lib/split-validation'
import { isCreditCardPayment } from '@/lib/categories'
import { writeOffsAsTxns } from '@/lib/reimbursements'

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

describe('validateSplitTarget', () => {
  // The $900 card payment the splits route must now refuse. It is excluded from spending AND income
  // (#31), so a $450 split on it reduces nothing — while writing the claim off later would freeze a
  // $450 "Loan Payments" row of spending the user never did, on top of the purchases the payment
  // already covered.
  const cardPayment = {
    pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT',
    user_category: null,
  }

  it('refuses a split on a credit-card payment', () => {
    const r = validateSplitTarget({ isCardPayment: isCreditCardPayment(cardPayment) })
    expect(r.ok).toBe(false)
    // The message has to explain WHY, since the transaction looks like a perfectly ordinary $900
    // outflow on the row the user just tapped.
    expect(r.ok === false && r.error).toMatch(/already counted as spending/)
  })

  it('allows a split on an ordinary transaction', () => {
    expect(
      validateSplitTarget({
        isCardPayment: isCreditCardPayment({ pfc_detailed: 'TRAVEL_LODGING', user_category: null }),
      })
    ).toEqual({ ok: true })
  })

  // A genuine loan payment (mortgage, car) is a real single-counted outflow, so it is splittable.
  it('allows a split on a non-card loan payment', () => {
    expect(
      validateSplitTarget({
        isCardPayment: isCreditCardPayment({
          pfc_detailed: 'LOAN_PAYMENTS_MORTGAGE_PAYMENT',
          user_category: null,
        }),
      }).ok
    ).toBe(true)
  })

  // The existing user-override contract: recategorizing a card payment by hand opts it back into
  // normal category logic, spending included, so a split on it is coherent again.
  it('allows a split on a card payment the user recategorized', () => {
    expect(
      validateSplitTarget({
        isCardPayment: isCreditCardPayment({ ...cardPayment, user_category: 'Shopping' }),
      }).ok
    ).toBe(true)
  })

  // WHY this must be refused at creation and cannot be patched up at write-off time: the synthesised
  // write-off row always carries a user_category, which isCreditCardPayment reads as a deliberate
  // user override. A frozen write-off row can therefore never be recognised as a card payment.
  it('cannot recognise a write-off row as a card payment', () => {
    const [row] = writeOffsAsTxns([
      { claim_id: 'c1', category: 'Loan Payments', amount: 450, date: '2026-11-03' },
    ])
    expect(isCreditCardPayment(row)).toBe(false)
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
