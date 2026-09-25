import { isCreditCardPayment, TRANSFER_PFC } from './categories'

// What a transaction MEANS, separate from how any one surface draws it. The desktop <tr>
// (TransactionRow) and the phone card (TransactionCard) have different markup and must not have
// different meaning: for every surface that renders a transaction, the sign convention, the colour
// rule and the card-payment exemption live here once, so a change reaches all of them or none.
//
// components/RecentActivity.tsx consumes this too, as of stage 2 of the phone pass. It renders a
// different, dashboard-sized list and keeps its own icon palette — an outflow is coral there and
// `text-ink` here — but it no longer flips the sign or decides what a card payment is. Those
// answers come from this module, so a change to the rules below reaches every surface.
export type PresentableTxn = {
  amount: number
  name: string | null
  merchant_name: string | null
  user_category: string | null
  pfc_primary: string | null
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
  // Your own money moving between your own accounts: a credit-card payment OR a transfer between
  // two depository accounts. The superset of `isCC`, and the one that answers "should this read as
  // money arriving or leaving?".
  isInternal: boolean
  // Narrower, and NOT interchangeable with isInternal. Only a card payment hides the category
  // picker and the reimbursable controls (TransactionRow.tsx, TransactionCard.tsx), because those
  // writes re-admit both legs into the totals. A transfer carries no such risk and must stay
  // recategorizable — widening this would strip the picker off every transfer row.
  isCC: boolean
  // Signed like `display`, or null when the transaction carries no mark.
  shareAmount: number | null
}

export function presentTransaction(t: PresentableTxn): PresentedTxn {
  // Plaid: amount > 0 means money OUT. Show spending as negative.
  //
  // `t.amount === 0` first: negating a zero yields -0, which Intl renders as "-$0.00" — the same
  // trap this module already disarms for `shareAmount` below. Left alone it ALSO escapes the
  // `display < 0` test, so a zero-amount transaction is toned as money arriving: RecentActivity
  // prefixes a '+' and paints the chip emerald, rendering "+-$0.00" in the colour reserved for
  // income. `-0 === 0` is true, so nothing short of the rendered string catches it.
  const display = t.amount === 0 ? 0 : -t.amount
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
  // Plaid tags a checking -> savings pair TRANSFER_IN / TRANSFER_OUT, which isCreditCardPayment
  // never matched — it keys off the DETAILED category and only for card payments. So both legs of
  // an ordinary transfer were toned like real money: the inflow emerald with a leading '+',
  // reading as a paycheque arriving. lib/dashboard.ts already skips transfers, so no total was
  // ever wrong — this is the same "keeps it out of the reading" fix #31 made for the card legs.
  //
  // `!t.user_category` for the same reason isCreditCardPayment carries it: a human who has
  // deliberately recategorized this row has overruled the Plaid mapping, and normal category
  // logic applies again.
  const isTransfer = !t.user_category && !!t.pfc_primary && TRANSFER_PFC.has(t.pfc_primary)
  const isInternal = isCC || isTransfer
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
    // Internal movement is neither spending nor income — every leg is already excluded from every
    // total. Painting a crediting leg emerald made a $7,866.69 card payment read as income (#31),
    // and did the same to every transfer into savings. A zero amount
    // is neither either, and must not fall through to the `in` arm the way `display < 0` alone
    // lets it.
    tone: isInternal || display === 0 ? 'neutral' : display < 0 ? 'out' : 'in',
    isInternal,
    isCC,
    shareAmount: marked > 0 ? share : null,
  }
}

export const TONE_CLASS: Record<PresentedTxn['tone'], string> = {
  out: 'text-ink',
  in: 'text-emerald',
  neutral: 'text-muted',
}
