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
  chain.single = async () => results[table] ?? { data: null, error: null }
  chain.maybeSingle = async () => results[table] ?? { data: null, error: null }
  chain.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(results[table] ?? { data: [], error: null }).then(resolve)
  return chain
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ from: (table: string) => chainFor(table) }),
}))
// Settings also reads plaid_items/plaid_slot_ledger/manual_assets, all via the service-role
// client (lib/supabase/admin) rather than the request-scoped one stubbed above. Stubbed out here
// exactly like tests/unit/dashboard-page.test.tsx does for plaid-items and manual-assets, so the
// page never makes a real network call — none of these three bear on the property under test.
vi.mock('@/lib/plaid-items', () => ({ listItemsForHousehold: async () => [] }))
vi.mock('@/lib/manual-assets', () => ({ listManualAssets: async () => [] }))
vi.mock('@/lib/plaid-slots', () => ({ countSlotsUsed: async () => null, LIFETIME_SLOTS: 10 }))

import SettingsPage from '@/app/(app)/settings/page'
import { TimezoneCard } from '@/components/TimezoneCard'

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
