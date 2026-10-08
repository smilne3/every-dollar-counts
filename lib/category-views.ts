// Category logic the pages used to do inline, where no test could reach it (#28 spec §7.2). Pure.
// Every function resolves through resolveCategory, so a rule relabels a row the same way in a
// list, a filter, a count and a total.
import { isCreditCardPayment } from './categories'
import { kindOf, resolveCategory, type CategorizableTxn, type CategoryContext } from './category-rules'
import { spendableAmount, type ReimbursableTxn } from './reimbursements'
import type { SpendContext } from './spend-context'
import { presentTransaction } from './transaction-presentation'

// The rows a category drill-down lists. Skips unpicked card payments, as spendByCategory does, so
// a Breakdown row and the list it opens add up (they display as "Card payment" and count in no
// total). Card payments still appear in the unfiltered list.
export function filterByCategory<T extends CategorizableTxn>(rows: T[], name: string, ctx: CategoryContext): T[] {
  return rows.filter((t) => !isCreditCardPayment(t) && resolveCategory(t, ctx).name === name)
}

// The rows behind Money in / Money out, matching monthlyFlows exactly: no card payments, no
// transfers, and netted through spendableAmount, so a fully reimbursable row (either direction)
// is in neither list. Money in is an income-category inflow; Money out is everything else that
// counts, refunds included, because a refund nets spending down.
//
// The flow=in fix: an employer repayment fully tagged to a claim used to still show under Money in
// though it adds $0 to income, so the list did not reconcile with the figure it drilled from. The
// `amt < 0` guard is the other half: an income-category OUTFLOW (a clawback, or a picked row) never
// reaches the income total, so it must not be listed under it either.
export function filterByFlow<T extends CategorizableTxn & ReimbursableTxn>(
  rows: T[],
  flow: 'in' | 'out',
  ctx: SpendContext
): T[] {
  return rows.filter((t) => {
    if (isCreditCardPayment(t)) return false
    const kind = kindOf(resolveCategory(t, ctx).name, ctx)
    if (kind === 'transfer') return false
    const amt = spendableAmount(t, ctx.reimbursedByTxn)
    if (amt === 0) return false
    return flow === 'in' ? kind === 'income' && amt < 0 : kind !== 'income'
  })
}

// One Recent activity entry on the dashboard. Meaning (label, sign, tone, the card-payment
// exemption) comes from presentTransaction; the category from resolveCategory. One source of
// meaning: the label fallback and the card-payment call used to be made on the dashboard page,
// independently of presentTransaction, which is exactly the duplication that module exists to end.
// `shareAmount` is unused here: this list shows no reimbursable state.
export function activityItem(
  t: Parameters<typeof presentTransaction>[0] & CategorizableTxn & { id: string; date: string },
  ctx: CategoryContext
) {
  const p = presentTransaction(t)
  return {
    id: t.id,
    date: t.date,
    category: resolveCategory(t, ctx).name,
    label: p.label,
    display: p.display,
    tone: p.tone,
    isInternal: p.isInternal,
  }
}
