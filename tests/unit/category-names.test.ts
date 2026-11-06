import { describe, it, expect } from 'vitest'
import { refusedCategoryName } from '@/lib/category-names'
import { resolveCategory } from '@/lib/category-rules'
import { NONE } from '@/lib/category-suggest-request'
import { capCategories } from '@/lib/trends'
import { testCtx } from './helpers/category-context'

const words = (name: string) => `“${name}” is a name the app uses. Choose another.`

describe('refusedCategoryName', () => {
  it.each(['Uncategorized', 'uncategorized', 'UNCATEGORIZED', 'Other', 'other', 'OTHER', 'None', 'none', 'NoNe'])(
    'refuses %s, a name the app shows for something else, in any case',
    (name) => {
      expect(refusedCategoryName(name)).toBe(words(name))
    }
  )

  // #243: a category by one of these names finds what every object inherits instead of its figures.
  it.each(Object.getOwnPropertyNames(Object.prototype))('refuses %s, which every object already has', (name) => {
    expect(refusedCategoryName(name)).toBe(words(name))
  })

  it.each(['Pets', 'Food & Drink', 'Other kids', 'None yet', 'Constructor', 'ToString', 'proto', 'Uncategorised'])(
    'allows %s',
    (name) => {
      expect(refusedCategoryName(name)).toBeNull()
    }
  )
})

// The names refused are the ones the app produces. If one of these changes, the list in
// lib/category-names.ts has to change with it.
describe('the names the app uses are refused', () => {
  it("the name a row shows when its bank's category maps to none", () => {
    const shown = resolveCategory(
      { user_category: null, pfc_primary: null, pfc_detailed: null, merchant_name: null, suggestion: null },
      testCtx()
    ).name
    expect(shown).toBe('Uncategorized')
    expect(refusedCategoryName(shown)).not.toBeNull()
  })

  it("the phone Trends chart's bar for the categories below its top six", () => {
    const rows = Array.from({ length: 7 }, (_, i) => ({ category: `C${i}`, current: 10 - i, previous: 10 - i }))
    const other = capCategories(rows).other
    expect(other).not.toBeNull()
    expect(refusedCategoryName(other!.category)).not.toBeNull()
  })

  it("Jev's answer when none of the categories fits", () => {
    expect(refusedCategoryName(NONE)).not.toBeNull()
  })
})
