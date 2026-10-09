import { describe, it, expect, beforeEach, vi } from 'vitest'

// vi.hoisted for the same reason as tests/unit/dashboard-page.test.tsx: the static page import
// below is linked before this file's body runs, firing the mock factory.
const { results } = vi.hoisted(() => ({
  results: {} as Record<string, { data: unknown; error: { message: string } | null }>,
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
    from: (table: string) => chainFor(table),
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
import { CategoryRulesCard } from '@/components/CategoryRulesCard'
import { BankList } from '@/components/BankList'
import { txnRows } from '../stubs/postgrest-pages'

const FOOD = { id: 'c-food', name: 'Food & Drink', pfc_primary: 'FOOD_AND_DRINK', sort_order: 0 }
const GROCERY = { id: 'c-grocery', name: 'Grocery', pfc_primary: null, sort_order: 1 }
const SAFEWAY_RULE = { id: 'r-safeway', household_id: 'hh-1', merchant_key: 'safeway', merchant_label: 'Safeway', category_id: 'c-grocery', origin: 'seeded' }

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

// The children of the first element with role="alert", walked the same way as findProps. Only
// finds markup the page itself writes: a component's own output is not in an unrendered tree.
function alertText(node: unknown): string | null {
  if (node == null || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = alertText(child)
      if (found != null) return found
    }
    return null
  }
  const el = node as { props?: { role?: unknown; children?: unknown } }
  if (el.props?.role === 'alert') return flatText(el.props.children)
  if (el.props && 'children' in el.props) return alertText(el.props.children)
  return null
}

function flatText(node: unknown): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(flatText).join('')
  return flatText((node as { props?: { children?: unknown } }).props?.children)
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

describe('Settings categories and rules', () => {
  // The delete-category dialog says how many transactions would move. On 2026-10-05 the household
  // had 1,366, and an unpaged read counted 1,000 of them (#69). readTransactionsForCounts pages (its
  // own test covers that); this pins that Settings counts every row it returns.
  it('counts every transaction, past the 1,000-row cap', async () => {
    results.categories = { data: [{ id: 'c1', name: 'Groceries', pfc_primary: 'FOOD_AND_DRINK', sort_order: 0 }], error: null }
    results.transactions = {
      data: txnRows(1366, '2025-10-18', { merchant_name: null, user_category: 'Groceries', pfc_primary: 'FOOD_AND_DRINK', pfc_detailed: null }),
      error: null,
    }
    const props = findProps(await SettingsPage(), CategoryManager) as { usage: Record<string, { txns: number }> }
    expect(props.usage.Groceries.txns).toBe(1366)
  })

  it('hands the delete dialog what a delete would move', async () => {
    results.categories = { data: [FOOD, GROCERY], error: null }
    results.category_rules = { data: [SAFEWAY_RULE], error: null }
    results.transactions = { data: [{ id: 't1', date: '2026-09-10', merchant_name: 'Safeway', user_category: null, pfc_primary: 'FOOD_AND_DRINK', pfc_detailed: null }], error: null }
    const props = findProps(await SettingsPage(), CategoryManager) as { usage: Record<string, { impact: unknown }> }
    expect(props.usage.Grocery.impact).toMatchObject({ moved: [{ name: 'Food & Drink', count: 1 }], rulesRemoved: 1 })
  })

  // #28 spec §8.3: each rule with what it does — the rows it relabels, and the merchant's
  // hand-picked rows it leaves alone.
  it('shows each rule with its counts', async () => {
    const TRAVEL = { id: 'c-travel', name: 'Travel', pfc_primary: 'TRAVEL', sort_order: 2 }
    const INCOME = { id: 'c-income', name: 'Income', pfc_primary: 'INCOME', sort_order: 3 }
    const TRANSFER_IN = { id: 'c-tin', name: 'Transfer In', pfc_primary: 'TRANSFER_IN', sort_order: 4 }
    results.categories = { data: [FOOD, GROCERY, TRAVEL, INCOME, TRANSFER_IN], error: null }
    results.category_rules = { data: [SAFEWAY_RULE], error: null }
    results.transactions = {
      data: [
        { id: 't1', date: '2026-09-10', merchant_name: 'Safeway', user_category: null, pfc_primary: 'FOOD_AND_DRINK', pfc_detailed: null },
        { id: 't2', date: '2026-09-11', merchant_name: 'Safeway', user_category: 'Travel', pfc_primary: 'FOOD_AND_DRINK', pfc_detailed: null },
      ],
      error: null,
    }
    const props = findProps(await SettingsPage(), CategoryRulesCard) as { rules: unknown; categories: unknown }
    expect(props.rules).toEqual([
      expect.objectContaining({ id: 'r-safeway', merchantLabel: 'Safeway', categoryName: 'Grocery', changed: 1, pickedByHand: 1, matching: 2 }),
    ])
    // Each category's kind decides which a rule may move to, so it must be the totals' kind.
    expect(props.categories).toEqual([
      { id: 'c-food', name: 'Food & Drink', kind: 'spending' },
      { id: 'c-grocery', name: 'Grocery', kind: 'spending' },
      { id: 'c-travel', name: 'Travel', kind: 'spending' },
      { id: 'c-income', name: 'Income', kind: 'income' },
      { id: 'c-tin', name: 'Transfer In', kind: 'transfer' },
    ])
  })

  // Settings is the only place a bank can be reconnected (spec §7.3), so a failed categories,
  // rules, transactions or budgets read must not take the page down. It must not render as "no
  // categories" either (#46), which would offer to create the defaults again.
  it.each([
    ['categories', () => (results.categories = { data: null, error: { message: 'boom' } })],
    ['rules', () => (results.category_rules = { data: null, error: { message: 'boom' } })],
    ['transactions', () => (results.transactions = { data: null, error: { message: 'boom' } })],
    ['budgets', () => (results.budgets = { data: null, error: { message: 'boom' } })],
  ])('keeps Banks usable and shows an alert when the %s read fails', async (_name, fail) => {
    fail()
    const tree = await SettingsPage()
    expect(findProps(tree, BankList)).not.toBeNull()
    expect(findProps(tree, CategoryManager)).toBeNull()
    expect(findProps(tree, CategoryRulesCard)).toBeNull()
    expect(alertText(tree)).toContain("Couldn't load categories and rules.")
  })

  // The logged message carries the error code, as the categories and rules reads' do.
  it.each([
    ['with a code', { message: 'boom', code: '42P01' }, 'could not read budgets: 42P01 boom'],
    ['without a code', { message: 'boom' }, 'could not read budgets: boom'],
  ])('logs a failed budgets read %s', async (_name, error, message) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    results.budgets = { data: null, error }
    await SettingsPage()
    expect(log).toHaveBeenCalledWith('[settings] could not load categories and rules', new Error(message))
    expect((log.mock.calls[0][1] as Error).message).toBe(message)
    log.mockRestore()
  })

  // No data and no error is not "no budgets" (#46): read so, the delete dialog would show every
  // budget as absent.
  it('shows the alert when the budgets read returns no data and no error', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    results.budgets = { data: null, error: null }
    const tree = await SettingsPage()
    expect(findProps(tree, BankList)).not.toBeNull()
    expect(findProps(tree, CategoryManager)).toBeNull()
    expect(alertText(tree)).toContain("Couldn't load categories and rules.")
    expect((log.mock.calls[0][1] as Error).message).toBe('could not read budgets: read returned no data and no error')
    log.mockRestore()
  })
})
