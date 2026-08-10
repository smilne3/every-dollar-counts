// Splits are constrained across ROWS: their total may not exceed the transaction, and a repayment
// may not exceed what the claim is still owed. A per-row `check` constraint cannot see siblings, so
// this runs server-side on every write. Pure, so it is testable without a database.

export type SplitValidation = { ok: true } | { ok: false; error: string }

export function validateSplit(input: {
  txnAmount: number // signed: > 0 money out, < 0 money in
  existingOnTxn: number // splits already on this transaction
  proposed: number // the new split amount
  isRepayment: boolean // derived from txnAmount < 0
  claimOutstanding: number // what the claim is still owed, before this split
}): SplitValidation {
  const { txnAmount, existingOnTxn, proposed, isRepayment, claimOutstanding } = input

  if (!(proposed > 0)) {
    return { ok: false, error: 'Split amount must be greater than zero.' }
  }

  const ceiling = Math.abs(txnAmount)
  if (existingOnTxn + proposed > ceiling + 0.001) {
    const room = Math.max(0, ceiling - existingOnTxn)
    return {
      ok: false,
      error: `Splits can't exceed the transaction. At most ${room.toFixed(2)} is left to assign.`,
    }
  }

  if (isRepayment && proposed > claimOutstanding + 0.001) {
    return {
      ok: false,
      error: `That's more than this claim is owed. At most ${claimOutstanding.toFixed(2)} can be applied; leave the rest untagged.`,
    }
  }

  return { ok: true }
}

// Some transactions cannot carry a split at all, whatever the amount. Checked before the amount
// rules, since no amount makes an ineligible transaction eligible.
//
// A credit-card payment is an internal transfer, not spending: the purchases it covers were already
// counted on the day each was made, which is why it is excluded from both spending and income
// (#31). Splitting one reduces nothing — and if the claim is later written off, the frozen row
// carries a `user_category`, the very field `isCreditCardPayment` treats as a deliberate user
// override, so the row can never be recognised as a card payment again. The full amount would land
// as brand-new spending in a category the user never spent in, on top of the purchases it paid for.
// The only place that can be stopped is here, at creation, while the transaction's Plaid detail is
// still attached to it.
export function validateSplitTarget(input: { isCardPayment: boolean }): SplitValidation {
  if (input.isCardPayment) {
    return {
      ok: false,
      error:
        "That's a credit-card payment. The purchases it paid off were already counted as spending on the days you made them, so splitting the payment would count that money twice. Split the individual purchases instead.",
    }
  }
  return { ok: true }
}

// Deleting a split can break invariants that only exist across the claim's OTHER rows, so this is
// evaluated against the totals the claim would have with the split already gone:
//   - A written-off claim's outstanding was frozen into reimbursement_write_offs at write-off time.
//     Removing a split afterward doesn't touch that frozen row, so the transaction's live spending
//     and the claim's frozen spending would silently drift apart in a month that may already be
//     closed. Once written off, a claim's splits are permanent history.
//   - On an open claim, deleting an OWED split can strip the justification out from under a
//     repayment split elsewhere on the same claim, leaving `returned` above `owed` — money that
//     genuinely arrived would then count as neither spending nor income. (Deleting a repayment
//     split can only lower `returned`, so it can never trip this on its own.)
export function validateSplitDeletion(input: {
  claimWrittenOff: boolean
  remainingOwed: number // the claim's `owed` total with this split already removed
  remainingReturned: number // the claim's `returned` total with this split already removed
}): SplitValidation {
  const { claimWrittenOff, remainingOwed, remainingReturned } = input

  if (claimWrittenOff) {
    return {
      ok: false,
      error:
        "That claim is written off: its splits are frozen into spending that already counted. Deleting one now would silently change a month that may already be closed.",
    }
  }

  if (remainingReturned > remainingOwed + 0.001) {
    return {
      ok: false,
      error: `Deleting this split would leave ${remainingReturned.toFixed(2)} returned against only ${remainingOwed.toFixed(2)} owed. Untag the repayment first.`,
    }
  }

  return { ok: true }
}
