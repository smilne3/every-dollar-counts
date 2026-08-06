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
