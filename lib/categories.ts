// Categories are now household-owned rows (see db/migrations/007). These helpers
// derive the Plaid-primary -> name mapping and spending sets from that list.

export type Category = {
  id: string
  name: string
  pfc_primary: string | null
  sort_order: number
}

// The default set (friendly name + the Plaid PFC primary it auto-maps from).
// Mirrors private.default_categories() in SQL; used for reference/seeding scripts.
export const DEFAULT_CATEGORIES: { name: string; pfc_primary: string }[] = [
  { name: 'Income', pfc_primary: 'INCOME' },
  { name: 'Transfer In', pfc_primary: 'TRANSFER_IN' },
  { name: 'Transfer Out', pfc_primary: 'TRANSFER_OUT' },
  { name: 'Loan Payments', pfc_primary: 'LOAN_PAYMENTS' },
  { name: 'Bank Fees', pfc_primary: 'BANK_FEES' },
  { name: 'Entertainment', pfc_primary: 'ENTERTAINMENT' },
  { name: 'Food & Drink', pfc_primary: 'FOOD_AND_DRINK' },
  { name: 'Shopping', pfc_primary: 'GENERAL_MERCHANDISE' },
  { name: 'Home', pfc_primary: 'HOME_IMPROVEMENT' },
  { name: 'Medical', pfc_primary: 'MEDICAL' },
  { name: 'Personal Care', pfc_primary: 'PERSONAL_CARE' },
  { name: 'Services', pfc_primary: 'GENERAL_SERVICES' },
  { name: 'Government & Nonprofit', pfc_primary: 'GOVERNMENT_AND_NON_PROFIT' },
  { name: 'Transportation', pfc_primary: 'TRANSPORTATION' },
  { name: 'Travel', pfc_primary: 'TRAVEL' },
  { name: 'Rent & Utilities', pfc_primary: 'RENT_AND_UTILITIES' },
]

// Plaid PFC primaries that are income/transfers (excluded from spending totals).
export const NON_SPENDING_PFC = new Set(['INCOME', 'TRANSFER_IN', 'TRANSFER_OUT'])

// Map: Plaid PFC primary -> the household's category name for it.
export function pfcToName(categories: Category[]): Record<string, string> {
  const m: Record<string, string> = {}
  for (const c of categories) if (c.pfc_primary) m[c.pfc_primary] = c.name
  return m
}

// Category names that count as spending (everything except income/transfers).
export function spendingCategoryNames(categories: Category[]): string[] {
  return categories
    .filter((c) => !(c.pfc_primary && NON_SPENDING_PFC.has(c.pfc_primary)))
    .map((c) => c.name)
}

// Set of category names that are income/transfers.
export function nonSpendingNames(categories: Category[]): Set<string> {
  return new Set(
    categories
      .filter((c) => c.pfc_primary && NON_SPENDING_PFC.has(c.pfc_primary))
      .map((c) => c.name)
  )
}
