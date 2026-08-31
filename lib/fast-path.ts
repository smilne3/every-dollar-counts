// The reimbursable fast path: a household pins the claims it reimburses against constantly (a work
// dinner), and the transaction row offers them in one tap. This module decides ONLY what the control
// should show — creating and deleting the splits is the existing splits API's job.

import { isCreditCardPayment } from './categories'

// The claim a transaction lands in when the user just says "this is reimbursable" without naming
// anything. Reimbursable spending is overwhelmingly work expenses, so the default is named for that
// case; anything else is still a claim the user creates by name in the split editor.
export const DEFAULT_CLAIM_NAME = 'Work'

// The first name in the `base`, `base (2)`, `base (3)` … series that no existing claim is using.
//
// Writing a claim off FREEZES it: the row survives as the record of spending that already counted,
// and `unique (household_id, name)` then holds its name forever. The one-tap control has no other
// name to fall back on — the user never typed one — so writing off "Work" would otherwise brick it
// permanently, every later tap failing to create a name that can never exist again.
//
// Bounded by construction: among the first `taken.length + 1` candidates, at most `taken.length` can
// be spoken for, so one is always free and the loop always returns.
export function nextFreeClaimName(base: string, taken: string[]): string {
  const norm = (n: string) => n.trim().toLowerCase()
  const used = new Set(taken.map(norm))
  if (!used.has(norm(base))) return base
  for (let n = 2; ; n++) {
    const candidate = `${base} (${n})`
    if (!used.has(norm(candidate))) return candidate
  }
}

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

// What ONE TAP does. Deliberately explicit rather than inferred from `applied`: "this claim is
// already on this transaction" and "tapping undoes it" stopped being the same statement the moment a
// claim could hold several splits on one transaction (see the multi-split rule below).
export type FastPathAction = 'assign' | 'undo'

export type FastPathEntry = {
  // null means THE DEFAULT CLAIM, which does not exist yet — the caller creates and pins it on the
  // first tap. Every later tap finds it in `pinned` and takes the ordinary path below.
  claimId: string | null
  claimName: string
  applied: boolean // this claim already has at least one split on this transaction
  splitCount: number // how many it has — more than one is the multi-split case
  action: FastPathAction // 'undo' removes `splitId`; 'assign' adds a new split of `amount`
  splitId: string | null // the split to remove; only ever set when action is 'undo'
  amount: number // what tapping would assign; 0 when action is 'undo'
}

export type FastPathState = {
  show: boolean
  remaining: number // the transaction's unsplit remainder
  entries: FastPathEntry[]
}

const HIDDEN: FastPathState = { show: false, remaining: 0, entries: [] }

export function fastPathState(
  txn: { amount: number; pfc_detailed: string | null; user_category: string | null },
  splits: FastPathSplit[],
  pinned: PinnedClaim[]
): FastPathState {
  // Plaid: amount > 0 is money OUT. A repayment isn't reimbursable — it gets tagged through the
  // split editor, which knows how to apply it against a claim's outstanding.
  if (!(txn.amount > 0)) return HIDDEN

  // The splits API refuses a split on a credit-card payment: the payment is already excluded from
  // both spending and income (the purchases were counted when they happened), so a split would
  // reduce nothing while a later write-off froze its full amount as invented spending. Rendering the
  // control here would be offering an action the server answers with a 400, so it isn't offered.
  if (isCreditCardPayment(txn)) return HIDDEN

  const assigned = splits.reduce((s, x) => s + x.amount, 0)
  // Clamped so a transaction somehow over-split can never offer a negative amount.
  const remaining = Math.max(0, txn.amount - assigned)

  // A written-off claim is refused by the splits API, so offering it would be an action the server
  // rejects. Drop it rather than render a button that only errors.
  const entries: FastPathEntry[] = pinned
    .filter((c) => c.written_off_on === null)
    .map((c) => {
      const mine = splits.filter((s) => s.claim_id === c.id)
      // THE MULTI-SPLIT RULE. One claim can legitimately hold SEVERAL splits on one transaction —
      // that is the point of the person axis (Dave/Sam/Priya each $250 of one $1,000 rental under
      // "Bourbon trail trip"). The fast path is a one-tap control for the simple case, and it has no
      // way to ask WHICH of those splits a tap meant, so:
      //
      //   exactly one split  -> the tap can undo it. This is the simple case the control is for.
      //   several splits     -> the tap must NOT undo anything (picking one by array order silently
      //                         destroys a person's share the user never pointed at, and the row
      //                         would still read "✓" afterwards, inviting a second tap). It also
      //                         must not read as a finished "✓" while money is still unassigned. So
      //                         the entry keeps its non-destructive half: it offers to assign the
      //                         remainder to the same claim, and the UI labels it as adding, not as
      //                         done. Removing an individual split stays the split editor's job —
      //                         the one surface that can show them one per line and name each one.
      //   several splits, nothing left to assign -> there is no safe one-tap action at all, so the
      //                         entry drops out below and the control steps aside entirely (the row
      //                         still has its "Splits" affordance opening the editor).
      const undoable = mine.length === 1 ? mine[0] : null
      return {
        claimId: c.id,
        claimName: c.name,
        applied: mine.length > 0,
        splitCount: mine.length,
        action: undoable ? ('undo' as const) : ('assign' as const),
        splitId: undoable?.id ?? null,
        amount: undoable ? 0 : remaining,
      }
    })
    // An 'assign' entry with nothing left to assign (amount 0) would only ever be rejected by the
    // splits API ("Split amount must be greater than zero") — the user never typed an amount, so
    // that message isn't actionable. Keep an entry only if it can be undone in one tap, or there is
    // still a remainder for it to take.
    .filter((e) => e.action === 'undo' || remaining > 0)

  // THE ON-RAMP. With no pinned claim to offer, the control used to disappear entirely — so saying
  // "this is reimbursable" first required going to the split editor and inventing a claim, which is
  // the concept backwards: reimbursable is the plain fact about the transaction, and which claim it
  // belongs to is the detail. Offer the default claim instead. It is deliberately the LAST resort:
  // a pinned claim is a choice the user actually made, so anything above wins over this.
  //
  // `remaining > 0` is the same condition every other entry is held to — there is no such thing as a
  // one-tap action that assigns nothing, and the splits API would refuse it anyway.
  if (!entries.length && remaining > 0) {
    return {
      show: true,
      remaining,
      entries: [
        {
          claimId: null,
          claimName: DEFAULT_CLAIM_NAME,
          applied: false,
          splitCount: 0,
          action: 'assign',
          splitId: null,
          amount: remaining,
        },
      ],
    }
  }

  // Every surviving entry is a real action (an undo, or an assign with money to assign), so having
  // any at all is exactly the condition for showing the control. Fully split to claims that aren't
  // pinned leaves none, and it disappears.
  const show = entries.length > 0
  return show ? { show, remaining, entries } : HIDDEN
}
