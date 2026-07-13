import { describe, it, expect } from 'vitest'
import { effectiveCategory } from '@/lib/effective-category'

const pfcMap = { FOOD_AND_DRINK: 'Food & Drink', MEDICAL: 'Medical' }

describe('effectiveCategory', () => {
  it('prefers the user override (a category name)', () => {
    expect(effectiveCategory({ user_category: 'Travel', pfc_primary: 'FOOD_AND_DRINK' }, pfcMap)).toBe(
      'Travel'
    )
  })

  it('falls back to the mapped Plaid category', () => {
    expect(effectiveCategory({ user_category: null, pfc_primary: 'MEDICAL' }, pfcMap)).toBe('Medical')
  })

  it('is Uncategorized when nothing maps', () => {
    expect(effectiveCategory({ user_category: null, pfc_primary: 'UNKNOWN_X' }, pfcMap)).toBe(
      'Uncategorized'
    )
    expect(effectiveCategory({ user_category: null, pfc_primary: null }, pfcMap)).toBe('Uncategorized')
  })
})
