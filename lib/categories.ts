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

// Plaid PFC primaries that are internal transfers (excluded from income totals,
// so moving money between your own accounts doesn't look like new income).
export const TRANSFER_PFC = new Set(['TRANSFER_IN', 'TRANSFER_OUT'])

// Paying off a credit card is an internal transfer, but Plaid tags it LOAN_PAYMENTS (not TRANSFER),
// so the primary-based sets above miss it. The give-away is the DETAILED category. A card payment
// shows up twice — money out of checking (looks like spending) and money into the card (looks like
// income) — and neither is real: the purchases were already counted as spending when they happened.
// So credit-card payments must be excluded from both spending and income. Genuine loan payments
// (mortgage, car, student) are real single-counted outflows and are NOT excluded.
const CREDIT_CARD_PAYMENT_DETAILED = 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT'

// True for an auto-categorized credit-card payment. A user override wins (existing contract): if
// they deliberately recategorized it, respect that and let normal category logic apply.
export function isCreditCardPayment(t: {
  pfc_detailed: string | null
  user_category: string | null
}): boolean {
  return !t.user_category && t.pfc_detailed === CREDIT_CARD_PAYMENT_DETAILED
}

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

// Set of category names that are internal transfers (excluded from income).
export function transferNames(categories: Category[]): Set<string> {
  return new Set(
    categories.filter((c) => c.pfc_primary && TRANSFER_PFC.has(c.pfc_primary)).map((c) => c.name)
  )
}
