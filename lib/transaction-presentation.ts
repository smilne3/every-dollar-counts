import { isCreditCardPayment } from './categories'

// What a transaction MEANS, separate from how any one surface draws it. The desktop <tr> and the
// phone card have different markup and must not have different meaning: the sign convention, the
// colour rule and the card-payment exemption live here once, so a change reaches both or neither.
export type PresentableTxn = {
  amount: number
  name: string | null
  merchant_name: string | null
  user_category: string | null
  pfc_detailed: string | null
  reimbursable_amount: number | null
}

export type PresentedTxn = {
  label: string | null
  display: number
  tone: 'out' | 'in' | 'neutral'
  isCC: boolean
  // Signed like `display`, or null when the transaction carries no mark.
  shareAmount: number | null
}

export function presentTransaction(t: PresentableTxn): PresentedTxn {
  // Plaid: amount > 0 means money OUT. Show spending as negative.
  const display = -t.amount
  const marked = Number(t.reimbursable_amount ?? 0)
  const isCC = isCreditCardPayment({ pfc_detailed: t.pfc_detailed, user_category: t.user_category })
  // The remainder, signed to match `display`. Lifted from spendableAmount (lib/reimbursements.ts),
  // INCLUDING its zero-normalisation: without the `=== 0` arm, negating a zero remainder yields
  // -0, which Intl renders as "-$0.00". Ticking the checkbox marks the full amount, so that is the
  // state most marked transactions are in — the meta line and the card's accessible name both read
  // "your share -$0.00". `-0 === 0` is true, so nothing short of the rendered string catches it.
  const remainder = Math.max(0, Math.abs(t.amount) - marked)
  const share = remainder === 0 ? 0 : t.amount < 0 ? remainder : -remainder
  return {
    label: t.merchant_name ?? t.name,
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
