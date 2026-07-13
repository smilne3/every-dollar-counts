// Plaid personal_finance_category (PFC) primary values -> friendly labels.
// The 16 primaries are stable; we group/label on these, never on .detailed.
export const CATEGORY_LABELS: Record<string, string> = {
  INCOME: 'Income',
  TRANSFER_IN: 'Transfer In',
  TRANSFER_OUT: 'Transfer Out',
  LOAN_PAYMENTS: 'Loan Payments',
  BANK_FEES: 'Bank Fees',
  ENTERTAINMENT: 'Entertainment',
  FOOD_AND_DRINK: 'Food & Drink',
  GENERAL_MERCHANDISE: 'Shopping',
  HOME_IMPROVEMENT: 'Home',
  MEDICAL: 'Medical',
  PERSONAL_CARE: 'Personal Care',
  GENERAL_SERVICES: 'Services',
  GOVERNMENT_AND_NON_PROFIT: 'Government & Nonprofit',
  TRANSPORTATION: 'Transportation',
  TRAVEL: 'Travel',
  RENT_AND_UTILITIES: 'Rent & Utilities',
}

export const CATEGORIES = Object.keys(CATEGORY_LABELS)

export function label(category: string | null | undefined): string {
  if (!category) return 'Uncategorized'
  return CATEGORY_LABELS[category] ?? category
}
