// A transaction's effective category is the user's override if present,
// otherwise Plaid's PFC primary. Budgets and Trends group on this.
export function effectiveCategory(t: {
  user_category: string | null
  pfc_primary: string | null
}): string {
  return t.user_category ?? t.pfc_primary ?? 'GENERAL_MERCHANDISE'
}
