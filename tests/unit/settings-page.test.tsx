import { describe, it, expect, beforeEach, vi } from 'vitest'

// vi.hoisted for the same reason as tests/unit/dashboard-page.test.tsx: the static page import
// below is linked before this file's body runs, firing the mock factory.
const { results, paged } = vi.hoisted(() => ({
  results: {} as Record<string, { data: unknown; error: { message: string } | null }>,
  // When set, `transactions` is served by a PostgREST-like stub that caps each response at 1,000
  // rows, so the test can tell a paged read from a plain one (#69).
  paged: { transactions: null as null | { query: () => Record<string, unknown> } },
}))

// A supabase query is a builder awaited at the end, so the stub returns itself for every chained
// method and resolves to whatever the test configured for that table.
const chainFor = (table: string) => {
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'order', 'eq', 'limit']) chain[m] = () => chain
  // readAllRows (lib/read-all.ts) asks for the rows after its cursor with .or(); there are none
  // past this fixture, so a continuation page is empty and the read ends.
  let afterCursor = false
  chain.or = () => {
    afterCursor = true
    return chain
  }
  chain.single = async () => results[table] ?? { data: null, error: null }
  chain.maybeSingle = async () => results[table] ?? { data: null, error: null }
  chain.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(
      afterCursor ? { data: [], error: null } : (results[table] ?? { data: [], error: null })
    ).then(resolve)
  return chain
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    from: (table: string) =>
      table === 'transactions' && paged.transactions ? paged.transactions.query() : chainFor(table),
  }),
}))
// Categories and rules come through lib/category-context.ts (#28), whose own test covers paging.
// Built from `results.categories` / `results.category_rules`, so a failed categories read still
// rejects with the page's message.
vi.mock('@/lib/category-context', async () => {
  const { testData } = await import('./helpers/category-context')
  return {
    fetchCategoryContext: async () => {
      const c = results.categories ?? { data: [], error: null }
      if (c.error) throw new Error(`could not read categories: ${c.error.message}`)
      const r = results.category_rules ?? { data: [], error: null }
      if (r.error) throw new Error(`could not read category rules: ${r.error.message}`)
      return testData(c.data as never, r.data as never)
    },
    readTransactionsForCounts: async () => {
      const t = results.transactions ?? { data: [], error: null }
      if (t.error) throw new Error(`could not read transactions: ${t.error.message}`)
      return t.data
    },
  }
})
// Settings also reads plaid_items/plaid_slot_ledger/manual_assets, all via the service-role
// client (lib/supabase/admin) rather than the request-scoped one stubbed above. Stubbed out here
// exactly like tests/unit/dashboard-page.test.tsx does for plaid-items and manual-assets, so the
// page never makes a real network call — none of these three bear on the property under test.
vi.mock('@/lib/plaid-items', () => ({ listItemsForHousehold: async () => [] }))
vi.mock('@/lib/manual-assets', () => ({ listManualAssets: async () => [] }))
vi.mock('@/lib/plaid-slots', () => ({ countSlotsUsed: async () => null, LIFETIME_SLOTS: 10 }))

import SettingsPage from '@/app/(app)/settings/page'
import { TimezoneCard } from '@/components/TimezoneCard'
import { CategoryManager } from '@/components/CategoryManager'
import { pagedTable, txnRows } from '../stubs/postgrest-pages'

// Server Components return an unrendered React element tree — no DOM, no hooks fired — so the
// prop SettingsPage hands TimezoneCard can be read straight off that tree without mounting
// anything downstream of it (InvitePartnerForm, BankList, CategoryManager, ...).
function findProps(node: unknown, type: unknown): Record<string, unknown> | null {
  if (node == null || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findProps(child, type)
      if (found) return found
    }
    return null
  }
  const el = node as { type?: unknown; props?: { children?: unknown } }
  if (el.type === type) return (el.props ?? {}) as Record<string, unknown>
  if (el.props && 'children' in el.props) return findProps(el.props.children, type)
  return null
}

beforeEach(() => {
  results.households = {
    data: [{ id: 'hh-1', name: 'Test Household', timezone: 'America/Los_Angeles' }],
    error: null,
  }
  results.accounts = { data: [], error: null, count: 0 } as unknown as {
    data: unknown
    error: null
  }
  results.categories = { data: [], error: null }
  results.category_rules = { data: [], error: null }
  results.transactions = { data: [], error: null }
  results.budgets = { data: [], error: null }
  paged.transactions = null
})

describe('Settings timezone control', () => {
  // The only place the app ever displays the zone that decides which month a household's money
  // is reported in. A household on America/Los_Angeles told it is on America/New_York would never
  // notice why its numbers are a day off (#73).
  it("passes the household's stored zone to the control, not the default", async () => {
    const tree = await SettingsPage()
    const props = findProps(tree, TimezoneCard)
    expect(props).not.toBeNull()
    expect(props?.current).toBe('America/Los_Angeles')
  })
})

describe('Settings categories and rules (#28)', () => {
  // Until Task 7 gives Settings its own "Couldn't load" state, a failed read must not render as a
  // household with no categories, which offers to create the defaults again (#46).
  it('throws when the rules cannot be read', async () => {
    results.category_rules = { data: null, error: { message: 'boom' } }
    await expect(SettingsPage()).rejects.toThrow(/could not read category rules/)
  })
})

describe('Settings category usage (#69)', () => {
  // The delete-category warning says how many transactions would move. On 2026-10-05 the household
  // had 1,366, and the unpaged read counted 1,000 of them: the warning undercounted by 366. A plain
  // read against this stub gets 1,000 too, so this fails if the page stops paging.
  it('counts every transaction, past the 1,000-row cap', async () => {
    results.categories = {
      data: [{ id: 'c1', name: 'Groceries', pfc_primary: 'FOOD_AND_DRINK', sort_order: 0 }],
      error: null,
    }
    paged.transactions = pagedTable(
      txnRows(1366, '2025-10-18', { user_category: 'Groceries', pfc_primary: 'FOOD_AND_DRINK' })
    )
    const tree = await SettingsPage()
    const props = findProps(tree, CategoryManager) as { usage: Record<string, { txns: number }> }
    expect(props.usage.Groceries.txns).toBe(1366)
  })

  // A failed read used to show every category as "0 transactions" (#91), and paging adds requests
  // that can fail. It must fail loudly instead, so app/(app)/error.tsx shows a retry.
  it('throws when the transactions read fails on a later page', async () => {
    paged.transactions = pagedTable(txnRows(1366, '2025-10-18'), { failOnRequest: 2 })
    await expect(SettingsPage()).rejects.toThrow(/could not read transactions/)
  })
})
