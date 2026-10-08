// Category logic the pages used to do inline, where no test could reach it (#28 spec §7.2). Pure.
// Every function resolves through resolveCategory, so a rule relabels a row the same way in a
// list, a filter, a count and a total.
import { isCreditCardPayment } from './categories'
import {
  buildCategoryContext,
  changedByRule,
  kindOf,
  merchantKey,
  resolveCategory,
  type CategorizableTxn,
  type CategoryContext,
  type CategoryData,
} from './category-rules'
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

export type RuleCounts = {
  changed: number // rows this rule relabels (changedByRule)
  pickedByHand: number // the merchant's rows that carry a hand pick
  matching: number // every row with the rule's merchant key; 0 shows "No current transactions"
}

// Settings' counts. Per category: how many rows show it, matching its drill-down exactly (so card
// payments without a pick are skipped, as filterByCategory skips them). Per rule: the counts the
// Category rules card shows. Takes CategoryData, not a context, because the per-rule counts need
// each rule's merchant key and a context deliberately hides its rules.
export function categoryUsage(
  rows: CategorizableTxn[],
  data: CategoryData,
  budgetNames: Set<string>
): { categories: Record<string, { txns: number; hasBudget: boolean }>; rules: Record<string, RuleCounts> } {
  const ctx = buildCategoryContext(data)
  const categories: Record<string, { txns: number; hasBudget: boolean }> = {}
  for (const c of data.categories) categories[c.name] = { txns: 0, hasBudget: budgetNames.has(c.name) }
  const rules: Record<string, RuleCounts> = {}
  const ruleIdByKey = new Map<string, string>()
  for (const r of data.rules) {
    rules[r.id] = { changed: 0, pickedByHand: 0, matching: 0 }
    ruleIdByKey.set(r.merchant_key, r.id)
  }
  for (const t of rows) {
    if (isCreditCardPayment(t)) continue
    const resolved = resolveCategory(t, ctx)
    if (Object.hasOwn(categories, resolved.name)) categories[resolved.name].txns++
    if (resolved.ruleId && changedByRule(resolved)) rules[resolved.ruleId].changed++
    const key = merchantKey(t.merchant_name)
    const ruleId = key ? ruleIdByKey.get(key) : undefined
    if (ruleId) {
      rules[ruleId].matching++
      if (t.user_category) rules[ruleId].pickedByHand++
    }
  }
  return { categories, rules }
}

export type DeleteImpact = {
  uncategorized: number
  moved: { name: string; count: number }[] // the top three destinations, by count
  movedMore: number // ROWS moving anywhere else
  rulesRemoved: number
  toSpending: number // rows whose kind becomes spending
}

// What deleting a category would do to each row, for the delete dialog (spec §8.4). Evaluates
// EVERY row, not only those showing the category: deleting a category can also expose another
// category that shares its Plaid primary. "After" mirrors the DELETE route, which removes the
// category (and, through the FK, its rules) and then clears picks carrying its name.
export function deleteImpact(rows: CategorizableTxn[], data: CategoryData, categoryId: string): DeleteImpact {
  const deleted = data.categories.find((c) => c.id === categoryId)
  const rulesRemoved = data.rules.filter((r) => r.category_id === categoryId).length
  if (!deleted) return { uncategorized: 0, moved: [], movedMore: 0, rulesRemoved, toSpending: 0 }
  const before = buildCategoryContext(data)
  const after = buildCategoryContext(data, { withoutCategoryId: categoryId })
  const destinations = new Map<string, number>()
  let uncategorized = 0
  let toSpending = 0
  for (const t of rows) {
    if (isCreditCardPayment(t)) continue
    const b = resolveCategory(t, before)
    const afterRow = { ...t, user_category: t.user_category === deleted.name ? null : t.user_category }
    // A card payment whose pick is cleared goes back to "Card payment", in no category and no total:
    // it leaves the deleted category and joins none, so it is neither moved nor new spending (#28).
    if (isCreditCardPayment(afterRow)) continue
    const a = resolveCategory(afterRow, after)
    if (a.name === b.name) continue
    if (a.name === 'Uncategorized') uncategorized++
    else destinations.set(a.name, (destinations.get(a.name) ?? 0) + 1)
    if (kindOf(b.name, before) !== 'spending' && kindOf(a.name, after) === 'spending') toSpending++
  }
  const ranked = [...destinations]
    .map(([name, count]) => ({ name, count }))
    .sort((x, y) => y.count - x.count || x.name.localeCompare(y.name))
  return {
    uncategorized,
    moved: ranked.slice(0, 3),
    movedMore: ranked.slice(3).reduce((s, m) => s + m.count, 0),
    rulesRemoved,
    toSpending,
  }
}
