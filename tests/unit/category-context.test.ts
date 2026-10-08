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

const categoriesRead = (result: { data: unknown; error: { message: string } | null }) => () => {
  const chain: Record<string, unknown> = {}
  chain.select = () => chain
  chain.order = (col: string) => {
    if (col !== 'sort_order') throw new Error(`unexpected order ${col}`)
    return chain
  }
  chain.then = (resolve: (r: unknown) => unknown) => Promise.resolve(result).then(resolve)
  return chain
}
const CATS = [{ id: 'c1', name: 'Grocery', pfc_primary: null, sort_order: 0 }]

beforeEach(() => {
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
    await expect(fetchCategoryContext()).rejects.toThrow('could not read categories: permission denied')
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
    await expect(readTransactionsForCounts()).rejects.toThrow('could not read transactions: boom')
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
