import { describe, it, expect, beforeEach, vi } from 'vitest'

// #28 spec §7.1: the one server read of categories and rules. A failed rules read must never
// render as "no rules": that would silently revert every learned label (#46).
const { tables } = vi.hoisted(() => ({
  tables: {} as Record<string, () => Record<string, unknown>>,
}))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ from: (table: string) => tables[table]() }),
}))

import { fetchCategoryContext, readTransactionsForCounts } from '@/lib/category-context'
import { readAllRows } from '@/lib/read-all'
import { idPagedTable, pagedTable, ruleRows, txnRows } from '../stubs/postgrest-pages'
import type { CategorizableTxn } from '@/lib/category-rules'

// Records what each categories read asked for, so a test can pin the columns and the order.
const catReads: { select: string | null; order: string | null }[] = []
const categoriesRead =
  (result: { data: unknown; error: { message: string; code?: string } | null }) => () => {
  const read: { select: string | null; order: string | null } = { select: null, order: null }
  catReads.push(read)
  const chain: Record<string, unknown> = {}
  chain.select = (cols: string) => {
    read.select = cols
    return chain
  }
  chain.order = (col: string) => {
    read.order = col
    return chain
  }
  chain.then = (resolve: (r: unknown) => unknown) => Promise.resolve(result).then(resolve)
  return chain
}
const CATS = [{ id: 'c1', name: 'Grocery', pfc_primary: null, sort_order: 0 }]

beforeEach(() => {
  catReads.length = 0
  tables.categories = categoriesRead({ data: CATS, error: null })
  tables.category_rules = idPagedTable([]).query
  tables.transactions = pagedTable([]).query
})

describe('fetchCategoryContext', () => {
  it('returns the categories in order and every rule', async () => {
    const rules = idPagedTable(ruleRows(1001))
    tables.category_rules = rules.query
    const data = await fetchCategoryContext()
    expect(data.categories).toEqual(CATS)
    expect(data.rules).toHaveLength(1001)
    expect(rules.requests.map((r) => r.after)).toEqual([null, 'r00999', 'r01000'])
  })

  it('throws when the categories read fails', async () => {
    tables.categories = categoriesRead({ data: null, error: { message: 'permission denied' } })
    await expect(fetchCategoryContext()).rejects.toThrow(/^could not read categories: permission denied$/)
  })

  it('names the error code when the categories read fails with one', async () => {
    tables.categories = categoriesRead({ data: null, error: { message: 'permission denied', code: '42501' } })
    await expect(fetchCategoryContext()).rejects.toThrow(/^could not read categories: 42501 permission denied$/)
  })

  // A response with neither data nor error (an empty body) is not "no categories": that would drop
  // every name, show every row as Uncategorized and count income as spending.
  it('throws when the categories read returns neither data nor error', async () => {
    tables.categories = categoriesRead({ data: null, error: null })
    await expect(fetchCategoryContext()).rejects.toThrow(
      /^could not read categories: read returned no data and no error$/
    )
  })

  // The casts in fetchCategoryContext mean a dropped column passes tsc; this pins the lists.
  it('reads exactly the columns the resolver and Settings need, categories in sort order', async () => {
    const rules = idPagedTable(ruleRows(3))
    tables.category_rules = rules.query
    await fetchCategoryContext()
    expect(catReads).toEqual([{ select: 'id, name, pfc_primary, sort_order', order: 'sort_order' }])
    // Every page asks for the same columns.
    expect([...new Set(rules.selects)]).toEqual(['id, household_id, merchant_key, merchant_label, category_id, origin'])
  })

  it('throws, naming the migration, when the rules read fails on any page', async () => {
    tables.category_rules = idPagedTable(ruleRows(1500), { failOnRequest: 2 }).query
    await expect(fetchCategoryContext()).rejects.toThrow(
      'could not read category rules: XX000 boom (has db/migrations/021, including its grants, been applied?)'
    )
  })
})

describe('readTransactionsForCounts', () => {
  it('reads 1,238 rows in pages of 1,000 and 238, then an empty page', async () => {
    const t = pagedTable(txnRows(1238, '2025-10-01', { merchant_name: null, user_category: null, pfc_primary: null, pfc_detailed: null }))
    tables.transactions = t.query
    expect(await readTransactionsForCounts()).toHaveLength(1238)
    expect(t.requests).toHaveLength(3)
  })

  it('returns every row when the server caps pages at 500', async () => {
    tables.transactions = pagedTable(txnRows(1238), { serverCap: 500 }).query
    expect(await readTransactionsForCounts()).toHaveLength(1238)
  })

  it('throws when the second page fails', async () => {
    tables.transactions = pagedTable(txnRows(1238), { failOnRequest: 2 }).query
    await expect(readTransactionsForCounts()).rejects.toThrow(/^could not read transactions: boom$/)
  })

  it('names the error code when the read fails with one', async () => {
    tables.transactions = pagedTable(txnRows(1238), { failOnRequest: 2, failCode: '57014' }).query
    await expect(readTransactionsForCounts()).rejects.toThrow(/^could not read transactions: 57014 boom$/)
  })
})

// Spec §7.4 layer 2: a read that drops a column the resolver needs must fail tsc. This function is
// never called; `npx tsc --noEmit` is the test.
async function _missingMerchantName(): Promise<(CategorizableTxn & { id: string; date: string })[]> {
  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()
  const { data } = await readAllRows(() =>
    supabase.from('transactions').select('id, date, user_category, pfc_primary, pfc_detailed').eq('removed', false)
  )
  // @ts-expect-error merchant_name is not selected
  return data ?? []
}
void _missingMerchantName
