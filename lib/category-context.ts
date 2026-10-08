import 'server-only'
import { cache } from 'react'
import { createClient } from './supabase/server'
import { readAllById, readAllRows } from './read-all'
import type { CategorizableTxn, CategoryData, CategoryRule } from './category-rules'
import type { Category } from './categories'

// The ONE read of the household's categories and category rules (#28 spec §7.1). Every money page
// and Settings goes through it; tripwire 4 holds every other `.from('categories')` and
// `.from('category_rules')` to a named allowlist.
//
// Cached per render (the lib/household.ts pattern), so a page that asks twice reads once.
//
// It THROWS on either read. A failed rules read rendered as "no rules" would silently revert every
// learned label across the app, which is #46's failure in a new place. Money pages let it reach
// app/(app)/error.tsx; Settings catches it so Banks stays usable.
export const fetchCategoryContext = cache(async (): Promise<CategoryData> => {
  const supabase = await createClient()
  const [cats, rules] = await Promise.all([
    supabase.from('categories').select('id, name, pfc_primary, sort_order').order('sort_order'),
    readAllById(() =>
      supabase
        .from('category_rules')
        .select('id, household_id, merchant_key, merchant_label, category_id, origin')
    ),
  ])
  if (cats.error) throw new Error(`could not read categories: ${cats.error.message}`)
  if (rules.error) {
    throw new Error(
      `could not read category rules: ${rules.error.code ?? ''} ${rules.error.message} ` +
        '(has db/migrations/021, including its grants, been applied?)'
    )
  }
  // The one place outside lib/category-rules.ts that brands CategoryData.
  return { categories: (cats.data ?? []) as Category[], rules: rules.data as CategoryRule[] } as CategoryData
})

export type CountTxn = CategorizableTxn & { id: string; date: string }

// Every non-removed transaction, with exactly the columns resolveCategory needs, for Settings'
// counts and the delete-category dialog. Paged (#69): about 1,400 rows today, three requests.
export async function readTransactionsForCounts(): Promise<CountTxn[]> {
  const supabase = await createClient()
  const { data, error } = await readAllRows(() =>
    supabase
      .from('transactions')
      .select('id, date, merchant_name, user_category, pfc_primary, pfc_detailed')
      .eq('removed', false)
  )
  if (error) throw new Error(`could not read transactions: ${error.message}`)
  return data
}
