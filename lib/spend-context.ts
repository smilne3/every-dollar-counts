import { buildCategoryContext, type CategoryContext, type CategoryData } from './category-rules'
import { reimbursableByTxn, type ReimbursableTxn } from './reimbursements'

// Everything the spending calculations need, assembled once per page: the household's categories
// and rules (a CategoryContext, so resolveCategory and kindOf work on it) plus the reimbursable map.
// Bundled because the five money surfaces used to assemble these by hand, and a page that forgot
// one still compiled and silently miscounted.
// Branded (type-only), so a page cannot hand-build one: a SpendContext comes only from
// buildSpendContext, the one place that casts it.
declare const SPEND_BRAND: unique symbol
export type SpendContext = CategoryContext & {
  readonly reimbursedByTxn: Readonly<Record<string, number>> // transaction id -> reimbursable amount
  readonly [SPEND_BRAND]: true
}

// `data` comes only from fetchCategoryContext (lib/category-context.ts), so a page cannot build a
// context without the rules. `txns` are the surface's OWN rows: reimbursable lives on the
// transaction, so there is no second query to forget.
export function buildSpendContext(input: { data: CategoryData; txns: ReimbursableTxn[] }): SpendContext {
  return { ...buildCategoryContext(input.data), reimbursedByTxn: reimbursableByTxn(input.txns) } as SpendContext
}
