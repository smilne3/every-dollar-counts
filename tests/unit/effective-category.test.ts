import { describe, it, expect } from 'vitest'
import { effectiveCategory } from '@/lib/effective-category'
import { DEFAULTS, GROCERY, categoriesFromMap, rule, testCtx } from './helpers/category-context'

const pfcMap = { FOOD_AND_DRINK: 'Food & Drink', MEDICAL: 'Medical' }
const ctx = testCtx(categoriesFromMap(pfcMap))
const row = (r: { user_category: string | null; pfc_primary: string | null }) => ({
  ...r,
  pfc_detailed: null,
  merchant_name: null,
})

describe('effectiveCategory', () => {
  it('prefers the user override (a category name)', () => {
    expect(effectiveCategory(row({ user_category: 'Travel', pfc_primary: 'FOOD_AND_DRINK' }), ctx)).toBe(
      'Travel'
    )
  })

  it('falls back to the mapped Plaid category', () => {
    expect(effectiveCategory(row({ user_category: null, pfc_primary: 'MEDICAL' }), ctx)).toBe('Medical')
  })

  it('is Uncategorized when nothing maps', () => {
    expect(effectiveCategory(row({ user_category: null, pfc_primary: 'UNKNOWN_X' }), ctx)).toBe(
      'Uncategorized'
    )
    expect(effectiveCategory(row({ user_category: null, pfc_primary: null }), ctx)).toBe('Uncategorized')
  })

  // #28: the merchant's rule sits between the hand pick and the bank's category.
  it("takes the merchant's rule over the bank's category", () => {
    const withRule = testCtx(DEFAULTS, [rule('Safeway', GROCERY.id)])
    expect(
      effectiveCategory(
        { user_category: null, pfc_primary: 'FOOD_AND_DRINK', pfc_detailed: null, merchant_name: 'Safeway' },
        withRule
      )
    ).toBe('Grocery')
  })
})
