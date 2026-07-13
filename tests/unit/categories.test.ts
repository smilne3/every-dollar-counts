import { describe, it, expect } from 'vitest'
import {
  DEFAULT_CATEGORIES,
  pfcToName,
  spendingCategoryNames,
  nonSpendingNames,
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
