import { resolveCategory, type CategorizableTxn, type CategoryContext } from './category-rules'

// A transaction's effective category NAME: its hand pick, else its merchant's rule (#28), else the
// household category its Plaid primary maps to, else 'Uncategorized'. See resolveCategory.
export function effectiveCategory(t: CategorizableTxn, ctx: CategoryContext): string {
  return resolveCategory(t, ctx).name
}
