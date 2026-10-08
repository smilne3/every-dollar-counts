// Test-only builders for category contexts (#28). The one place outside lib/ that casts a brand:
// production code gets CategoryData only from fetchCategoryContext (lib/category-context.ts), and
// tripwire 4's brand-cast check does not scan tests.
import { DEFAULT_CATEGORIES, type Category } from '@/lib/categories'
import {
  buildCategoryContext,
  merchantKey,
  type CategoryData,
  type CategoryRule,
} from '@/lib/category-rules'

export const HH = 'hh-1'

export function cat(name: string, pfc_primary: string | null = null, sort_order = 0): Category {
  return { id: `c-${name}`, name, pfc_primary, sort_order }
}

// The household's defaults (lib/categories.ts DEFAULT_CATEGORIES) plus its own Grocery.
export const GROCERY = cat('Grocery', null, 100)
export const DEFAULTS: Category[] = [
  ...DEFAULT_CATEGORIES.map((c, i) => cat(c.name, c.pfc_primary, i)),
  GROCERY,
]

export function rule(merchant: string, categoryId: string, over: Partial<CategoryRule> = {}): CategoryRule {
  const key = merchantKey(merchant)
  if (!key) throw new Error(`rule(): '${merchant}' has no merchant key`)
  return {
    id: `r-${key}`,
    household_id: HH,
    merchant_key: key,
    merchant_label: merchant.trim(),
    category_id: categoryId,
    origin: 'learned',
    ...over,
  }
}

export function testData(categories: Category[], rules: CategoryRule[] = []): CategoryData {
  return { categories, rules } as CategoryData
}

export function testCtx(categories: Category[] = DEFAULTS, rules: CategoryRule[] = []) {
  return buildCategoryContext(testData(categories, rules))
}

// For tests written against the old `pfcMap` shape: one category per entry, in order.
export function categoriesFromMap(map: Record<string, string>): Category[] {
  return Object.entries(map).map(([pfc, name], i) => cat(name, pfc, i))
}
