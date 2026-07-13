import { describe, it, expect } from 'vitest'
import { CATEGORIES, CATEGORY_LABELS, label } from '@/lib/categories'

describe('categories', () => {
  it('has all 16 PFC primary categories', () => {
    expect(CATEGORIES).toHaveLength(16)
  })

  it('maps a known primary to a friendly label', () => {
    expect(label('FOOD_AND_DRINK')).toBe('Food & Drink')
  })

  it('gives every category a non-empty label', () => {
    for (const c of CATEGORIES) expect(CATEGORY_LABELS[c]).toBeTruthy()
  })

  it('handles null/unknown gracefully', () => {
    expect(label(null)).toBe('Uncategorized')
    expect(label('WEIRD_NEW_CAT')).toBe('WEIRD_NEW_CAT')
  })
})
