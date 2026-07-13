import { describe, it, expect } from 'vitest'
import { effectiveCategory } from '@/lib/effective-category'

describe('effectiveCategory', () => {
  it('prefers the user override', () => {
    expect(effectiveCategory({ user_category: 'TRAVEL', pfc_primary: 'FOOD_AND_DRINK' })).toBe('TRAVEL')
  })

  it('falls back to pfc_primary when no override', () => {
    expect(effectiveCategory({ user_category: null, pfc_primary: 'MEDICAL' })).toBe('MEDICAL')
  })

  it('falls back to a default when both are missing', () => {
    expect(effectiveCategory({ user_category: null, pfc_primary: null })).toBe('GENERAL_MERCHANDISE')
  })
})
