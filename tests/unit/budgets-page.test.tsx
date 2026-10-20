import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const { calls, tz, results, selects } = vi.hoisted(() => ({
  // Every `.select()` the page sends, per table, so a test can pin the suggestion embed (§7.4).
  selects: {} as Record<string, string[]>,
  calls: { gte: [] as string[], lt: [] as string[] },
  tz: { value: 'America/New_York' },
  results: {} as Record<string, { data: unknown; error: { message: string } | null }>,
}))

// A supabase query is a builder awaited at the end, so the stub returns itself for every chained
// method and resolves to whatever the test configured for that table. The date bounds the page
// asks the database for are recorded, since they are the behaviour under test in the first block.
const chainFor = (table: string) => {
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'order', 'eq', 'limit']) chain[m] = () => chain
  chain.select = (cols: string) => {
    (selects[table] ??= []).push(cols)
    return chain
  }
  // readAllRows (lib/read-all.ts) asks for the rows after its cursor with .or(); there are none
  // past this fixture, so a continuation page is empty and the read ends.
  let afterCursor = false
  chain.or = () => {
    afterCursor = true
    return chain
  }
  chain.gte = (_col: string, v: string) => {
    calls.gte.push(v)
    return chain
  }
  chain.lt = (_col: string, v: string) => {
    calls.lt.push(v)
    return chain
  }
  chain.single = async () => results[table] ?? { data: null, error: null }
  chain.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(
      afterCursor ? { data: [], error: null } : (results[table] ?? { data: [], error: null })
    ).then(resolve)
  return chain
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ from: (table: string) => chainFor(table) }),
}))
// The service-role client reads only plaid_items here, for the "isn't syncing" banner (#135),
// through the strict stand-in in tests/stubs/plaid-items.ts: it applies the read's filters to the
// stored rows, so the banner shows only this household's banks. lib/plaid-items.ts runs for real,
// and needs only plaidEnv from lib/plaid.
vi.mock('@/lib/supabase/admin', async () => {
  const { plaidItemsQuery } = await import('../stubs/plaid-items')
  return {
    supabaseAdmin: {
      from: (table: string) => {
        if (table !== 'plaid_items') throw new Error(`budgets page read ${table} through the service-role client`)
        return plaidItemsQuery(results.plaid_items ?? { data: [], error: null })
      },
    },
  }
})
vi.mock('@/lib/plaid', () => ({ plaidEnv: 'sandbox' }))
// Categories and rules come through lib/category-context.ts (#28), whose own test covers paging.
// Built from `results.categories` / `results.category_rules`, so a failed categories read still
// rejects with the page's message.
// The real module otherwise, so the page gets the real SUGGESTION_EMBED and the switch is read by
// the real suggestionsEnabled (spec §14.7).
vi.mock('@/lib/category-context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/category-context')>()
  const { testData } = await import('./helpers/category-context')
  return {
    ...actual,
    fetchCategoryContext: async () => {
      const c = results.categories ?? { data: [], error: null }
      if (c.error) throw new Error(`could not read categories: ${c.error.message}`)
      const r = results.category_rules ?? { data: [], error: null }
      if (r.error) throw new Error(`could not read category rules: ${r.error.message}`)
      return testData(c.data as never, r.data as never, { suggestionsOn: actual.suggestionsEnabled() })
    },
    readTransactionsForCounts: async () => {
      const t = results.transactions ?? { data: [], error: null }
      if (t.error) throw new Error(`could not read transactions: ${t.error.message}`)
      return t.data
    },
  }
})
// The real module but for the timezone, so currentHouseholdId reads `results.memberships`.
vi.mock('@/lib/household', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/household')>()),
  householdTimezone: async () => tz.value,
}))

import BudgetsPage from '@/app/(app)/budgets/page'
import { BudgetEditor } from '@/components/BudgetEditor'
import { NotSyncingBanner } from '@/components/NotSyncingBanner'
import { PageHeader } from '@/components/ui/PageHeader'
import { catalogFingerprint } from '@/lib/category-rules'
import { sug } from './helpers/category-context'
import { blocks, bannerText } from './helpers/banner'
import { storedItem, FOREIGN_ITEMS } from '../stubs/plaid-items'

const FOOD = { id: 'c-food', name: 'Food & Drink', pfc_primary: 'FOOD_AND_DRINK', sort_order: 0 }
const GROCERY = { id: 'c-grocery', name: 'Grocery', pfc_primary: null, sort_order: 1 }
const SAFEWAY_RULE = { id: 'r-safeway', household_id: 'hh-1', merchant_key: 'safeway', merchant_label: 'Safeway', category_id: 'c-grocery', origin: 'seeded' }

// Server Components return an unrendered React element tree, so the props the page hands
// BudgetEditor can be read straight off it (copied from tests/unit/settings-page.test.tsx).
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
  vi.useFakeTimers()
  calls.gte = []
  calls.lt = []
  tz.value = 'America/New_York'
  for (const k of Object.keys(results)) delete results[k]
  results.memberships = { data: { household_id: 'hh-1' }, error: null }
  results.plaid_items = { data: [], error: null }
  for (const k of Object.keys(selects)) delete selects[k]
  vi.unstubAllEnvs()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

// The dashboard's banner, above this month's spending against each budget (#135).
describe('Budgets banks (#135)', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-09-15T12:00:00Z'))
  })

  it("warns that a bank isn't syncing, first, above the header", async () => {
    results.plaid_items = {
      data: [storedItem({ status: 'temporarily_unavailable' }), storedItem({ id: 'item-2', institution_name: 'Amex' }), ...FOREIGN_ITEMS],
      error: null,
    }
    const tree = await BudgetsPage()
    expect(bannerText(tree)).toBe("Capital One isn't syncing — see Settings. These figures may be out of date.")
    const order = blocks(tree).map((b) => b.type)
    expect(order.indexOf(NotSyncingBanner)).toBe(0)
    expect(order.indexOf(PageHeader)).toBe(1)
  })

  // Another household's broken bank, or this household's from the other Plaid environment, must
  // not raise the banner here.
  it("says nothing while every one of the household's banks is syncing", async () => {
    results.plaid_items = { data: [storedItem(), ...FOREIGN_ITEMS], error: null }
    expect(bannerText(await BudgetsPage())).toBe('')
  })

  // Rendered as no banks, a failed read would show this month's bars with no warning (#46). It
  // throws, as the dashboard does, and app/(app)/error.tsx offers a retry.
  it('fails loudly when the banks read fails, rather than hiding the banner', async () => {
    results.plaid_items = { data: null, error: { message: 'statement timeout' } }
    await expect(BudgetsPage()).rejects.toThrow(/could not read linked banks: statement timeout/)
  })

  it('fails loudly when the household read fails, rather than hiding the banner', async () => {
    results.memberships = { data: null, error: { message: 'permission denied' } }
    await expect(BudgetsPage()).rejects.toThrow(/could not read your household: permission denied/)
  })
})

describe('Budgets month window', () => {
  // At 8:10pm on 31 August the server is already in September, so every bar emptied four hours
  // early (#73).
  it('uses the household\'s month, not the server\'s', async () => {
    vi.setSystemTime(new Date('2026-09-01T00:10:00Z'))
    await BudgetsPage()
    expect(calls.gte).toContain('2026-08-01')
    expect(calls.lt).toContain('2026-09-01')
  })

  it('rolls over when the household\'s month actually changes', async () => {
    vi.setSystemTime(new Date('2026-09-01T12:00:00Z')) // 8am on 1 September in New York
    await BudgetsPage()
    expect(calls.gte).toContain('2026-09-01')
    expect(calls.lt).toContain('2026-10-01')
  })

  it('crosses a year boundary correctly', async () => {
    vi.setSystemTime(new Date('2026-12-15T12:00:00Z'))
    await BudgetsPage()
    expect(calls.gte).toContain('2026-12-01')
    expect(calls.lt).toContain('2027-01-01')
  })
})

describe('Budgets categories and rules (#28)', () => {
  it('files Safeway under Grocery through its rule', async () => {
    vi.setSystemTime(new Date('2026-09-15T12:00:00Z'))
    results.categories = { data: [FOOD, GROCERY], error: null }
    results.category_rules = { data: [SAFEWAY_RULE], error: null }
    results.transactions = {
      data: [
        { id: 't1', amount: 42, date: '2026-09-10', merchant_name: 'Safeway', user_category: null, pfc_primary: 'FOOD_AND_DRINK', pfc_detailed: null, reimbursable_amount: null },
      ],
      error: null,
    }
    const props = findProps(await BudgetsPage(), BudgetEditor)
    expect(props?.spend).toEqual({ Grocery: 42 })
  })

  // Spec §14.3/§14.7: a Whole Foods row with no rule takes Jev's confident suggestion, and only
  // while CATEGORY_SUGGESTIONS is on.
  const wholeFoods = (suggestion: unknown) => ({
    id: 't2', amount: 30, date: '2026-09-11', merchant_name: 'Whole Foods', user_category: null,
    pfc_primary: 'FOOD_AND_DRINK', pfc_detailed: null, reimbursable_amount: null, suggestion,
  })
  const spendWith = async (rows: unknown[]) => {
    vi.setSystemTime(new Date('2026-09-15T12:00:00Z'))
    results.categories = { data: [FOOD, GROCERY], error: null }
    results.category_rules = { data: [], error: null }
    results.transactions = { data: rows, error: null }
    return findProps(await BudgetsPage(), BudgetEditor)?.spend
  }

  it('files Whole Foods under Grocery through its suggestion when suggestions are on', async () => {
    vi.stubEnv('CATEGORY_SUGGESTIONS', 'on')
    const spend = await spendWith([wholeFoods(sug(GROCERY.id, 0.99, catalogFingerprint([FOOD, GROCERY])))])
    expect(spend).toEqual({ Grocery: 30 })
  })

  it('leaves Whole Foods under Food & Drink when suggestions are off', async () => {
    vi.stubEnv('CATEGORY_SUGGESTIONS', undefined)
    const spend = await spendWith([wholeFoods(sug(GROCERY.id, 0.99, catalogFingerprint([FOOD, GROCERY])))])
    expect(spend).toEqual({ 'Food & Drink': 30 })
  })

  // Review Focus 5: switching on changes nothing for rows that carry no suggestion.
  it('renders the same with the switch on as off when no row has a suggestion', async () => {
    const rows = [wholeFoods(null), { ...wholeFoods(null), id: 't3', merchant_name: 'Safeway', amount: 12 }]
    vi.stubEnv('CATEGORY_SUGGESTIONS', 'on')
    const on = await spendWith(rows)
    vi.stubEnv('CATEGORY_SUGGESTIONS', undefined)
    const off = await spendWith(rows)
    expect(on).toEqual({ 'Food & Drink': 42 })
    expect(on).toEqual(off)
  })

  // Spec §7.4's coverage guard: every transactions read the page resolves carries the embed.
  it('selects each transaction\'s suggestion', async () => {
    await spendWith([])
    expect(selects.transactions?.length).toBeGreaterThan(0)
    for (const cols of selects.transactions) expect(cols).toContain('category_suggestions(')
  })

  // A failed rules read rendered as "no rules" would quietly move every learned label back (#46).
  it('throws when the categories and rules cannot be read', async () => {
    vi.setSystemTime(new Date('2026-09-15T12:00:00Z'))
    results.category_rules = { data: null, error: { message: 'boom' } }
    await expect(BudgetsPage()).rejects.toThrow(/could not read category rules/)
  })
})
