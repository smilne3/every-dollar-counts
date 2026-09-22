import { isCreditCardPayment } from './categories'

// What a transaction MEANS, separate from how any one surface draws it. The desktop <tr>
// (TransactionRow) and the phone card (TransactionCard) have different markup and must not have
// different meaning: for those two, the sign convention, the colour rule and the card-payment
// exemption live here once, so a change reaches both or neither.
//
// Scoped to that pair deliberately. components/RecentActivity.tsx is a KNOWN third copy — it flips
// the sign itself (line 25) and carries a tone ternary structurally identical to TONE_CLASS (lines
// 34 and 52) — and it does not go through here. It renders a different, dashboard-sized list from
// a different shape (ActivityItem, with the card-payment call already made upstream as
// `internalTransfer`), so consolidating it is a separate piece of work, not an oversight. Anyone
// changing the rules below has to change that file too.
export type PresentableTxn = {
  amount: number
  name: string | null
  merchant_name: string | null
  user_category: string | null
  pfc_detailed: string | null
  reimbursable_amount: number | null
}

export type PresentedTxn = {
  // Never null. It used to be, and the two surfaces then each invented their own answer: the card
  // showed "Transaction", the desktop row rendered the empty label into the merchant cell and
  // spelled its control labels two further ways ('transaction' for the checkbox and the editor,
  // `undefined` for the picker). A merchant's name is meaning, not markup, so the fallback belongs
  // here with the rest of it — one answer, which the §9 parity test pins.
  label: string
  display: number
  tone: 'out' | 'in' | 'neutral'
  isCC: boolean
  // Signed like `display`, or null when the transaction carries no mark.
  shareAmount: number | null
}

export function presentTransaction(t: PresentableTxn): PresentedTxn {
  // Plaid: amount > 0 means money OUT. Show spending as negative.
  const display = -t.amount
  // Plaid always sends `name`, so the fallback is the belt-and-braces case rather than the common
  // one — but it is the case where the two surfaces used to diverge.
  const label = t.merchant_name ?? t.name ?? 'Transaction'
  const marked = Number(t.reimbursable_amount ?? 0)
  // An unreadable amount MUST NOT pass as "unmarked". Left alone, `marked > 0` is false for NaN,
  // shareAmount comes out null, and both surfaces draw a broken value as a perfectly ordinary
  // one — indistinguishable, to the reader, from a transaction nobody ever ticked. Infinity is
  // worse still: it is > 0, so the remainder clamps to zero and the row cheerfully reports "your
  // share $0.00" on a charge that is entirely unaccounted for.
  //
  // Not reachable today: the column is `numeric` with a CHECK, and the only writer clamps. But
  // this module's stated job is being the authoritative answer, and it inherited no validation
  // from the pattern it consolidated. Throwing rather than inventing a third rendering is the
  // choice this codebase already makes when it cannot vouch for a figure — see the transactions
  // page, which throws rather than let "no transactions" and "we could not read your
  // transactions" look the same (#46). It does take out the whole list; a wrong share the
  // household believes is the outcome that is worse.
  if (!Number.isFinite(marked)) {
    throw new Error(
      `reimbursable_amount is not a number on "${label}": ${String(t.reimbursable_amount)}`
    )
  }
  const isCC = isCreditCardPayment({ pfc_detailed: t.pfc_detailed, user_category: t.user_category })
  // The remainder, signed to match `display`. Lifted from spendableAmount (lib/reimbursements.ts),
  // INCLUDING its zero-normalisation: without the `=== 0` arm, negating a zero remainder yields
  // -0, which Intl renders as "-$0.00". Ticking the checkbox marks the full amount, so that is the
  // state most marked transactions are in — the meta line and the card's accessible name both read
  // "your share -$0.00". `-0 === 0` is true, so nothing short of the rendered string catches it.
  const remainder = Math.max(0, Math.abs(t.amount) - marked)
  const share = remainder === 0 ? 0 : t.amount < 0 ? remainder : -remainder
  return {
    label,
    display,
    // A card payment is neither spending nor income — both legs are already excluded from every
    // total. Painting the crediting leg emerald made $7,866.69 read as income (#31).
    tone: isCC ? 'neutral' : display < 0 ? 'out' : 'in',
    isCC,
    shareAmount: marked > 0 ? share : null,
  }
}

export const TONE_CLASS: Record<PresentedTxn['tone'], string> = {
  out: 'text-ink',
  in: 'text-emerald',
  neutral: 'text-muted',
}
