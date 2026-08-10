// The reimbursable fast path: a household pins the claims it reimburses against constantly (a work
// dinner), and the transaction row offers them in one tap. This module decides ONLY what the control
// should show — creating and deleting the splits is the existing splits API's job.

export type PinnedClaim = {
  id: string
  name: string
  written_off_on: string | null
}

export type FastPathSplit = {
  id: string
  claim_id: string
  amount: number
}

export type FastPathEntry = {
  claimId: string
  claimName: string
  applied: boolean // this claim already has a split on this transaction
  splitId: string | null // the split to remove when applied
  amount: number // what tapping would assign; 0 when already applied
}

export type FastPathState = {
  show: boolean
  remaining: number // the transaction's unsplit remainder
  entries: FastPathEntry[]
}

const HIDDEN: FastPathState = { show: false, remaining: 0, entries: [] }

export function fastPathState(
  txn: { amount: number },
  splits: FastPathSplit[],
  pinned: PinnedClaim[]
): FastPathState {
  // Plaid: amount > 0 is money OUT. A repayment isn't reimbursable — it gets tagged through the
  // split editor, which knows how to apply it against a claim's outstanding.
  if (!(txn.amount > 0)) return HIDDEN

  const assigned = splits.reduce((s, x) => s + x.amount, 0)
  // Clamped so a transaction somehow over-split can never offer a negative amount.
  const remaining = Math.max(0, txn.amount - assigned)

  // A written-off claim is refused by the splits API, so offering it would be an action the server
  // rejects. Drop it rather than render a button that only errors.
  const entries: FastPathEntry[] = pinned
    .filter((c) => c.written_off_on === null)
    .map((c) => {
      const existing = splits.find((s) => s.claim_id === c.id)
      return {
        claimId: c.id,
        claimName: c.name,
        applied: !!existing,
        splitId: existing?.id ?? null,
        amount: existing ? 0 : remaining,
      }
    })
    // An entry that isn't applied and has nothing left to assign (amount 0) would only ever be
    // rejected by the splits API ("Split amount must be greater than zero") — the user never typed
    // an amount, so that message isn't actionable. Only offer it if it's applied (so it can be
    // undone) or there's still a remainder to give it.
    .filter((e) => e.applied || remaining > 0)

  // Show only if there's something to do: an applied claim to undo, or room left to assign.
  // Fully split to claims that aren't pinned leaves neither, so the control disappears entirely.
  const show = entries.some((e) => e.applied) || (remaining > 0 && entries.length > 0)
  return show ? { show, remaining, entries } : HIDDEN
}
