import { describe, it, expect } from 'vitest'
import {
  DEFAULT_CATEGORIES,
  pfcToName,
  spendingCategoryNames,
  nonSpendingNames,
  isCardPaymentRow,
  isCreditCardPayment,
  CREDIT_CARD_PAYMENT_DETAILED,
  type Category,
} from '@/lib/categories'

const cats: Category[] = [
  ...DEFAULT_CATEGORIES.map((d, i) => ({
    id: String(i),
    name: d.name,
    pfc_primary: d.pfc_primary as string | null,
    sort_order: i,
  })),
  { id: '99', name: 'Pets', pfc_primary: null, sort_order: 99 },
]

describe('categories', () => {
  it('has 16 defaults', () => {
    expect(DEFAULT_CATEGORIES).toHaveLength(16)
  })

  it('maps a Plaid primary to the household name', () => {
    expect(pfcToName(cats)['FOOD_AND_DRINK']).toBe('Food & Drink')
    expect(pfcToName(cats)['GENERAL_MERCHANDISE']).toBe('Shopping')
  })

  it('spending names exclude income/transfers, include custom', () => {
    const names = spendingCategoryNames(cats)
    expect(names).not.toContain('Income')
    expect(names).not.toContain('Transfer In')
    expect(names).toContain('Food & Drink')
    expect(names).toContain('Pets')
  })

  it('non-spending names are just income/transfers', () => {
    expect(nonSpendingNames(cats)).toEqual(new Set(['Income', 'Transfer In', 'Transfer Out']))
  })
})

// #28 spec §5.2. A card payment is a card payment whatever its label: the route refuses to change
// one, and neither surface offers a picker on one, even when someone filed it by hand before.
// isCreditCardPayment answers a different question ("does it count in the totals?") and returns
// false once a pick is set, which is why the two must not be confused.
describe('isCardPaymentRow', () => {
  it('is true for the card-payment detailed category', () => {
    expect(isCardPaymentRow('LOAN_PAYMENTS_CREDIT_CARD_PAYMENT')).toBe(true)
    expect(CREDIT_CARD_PAYMENT_DETAILED).toBe('LOAN_PAYMENTS_CREDIT_CARD_PAYMENT')
  })

  it('is false for anything else, including null', () => {
    expect(isCardPaymentRow(null)).toBe(false)
    expect(isCardPaymentRow('LOAN_PAYMENTS_MORTGAGE_PAYMENT')).toBe(false)
  })

  it('ignores a pick, unlike isCreditCardPayment', () => {
    const picked = { pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', user_category: 'Shopping' }
    expect(isCardPaymentRow(picked.pfc_detailed)).toBe(true)
    expect(isCreditCardPayment(picked)).toBe(false)
  })
})
