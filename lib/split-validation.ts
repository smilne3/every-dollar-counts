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
