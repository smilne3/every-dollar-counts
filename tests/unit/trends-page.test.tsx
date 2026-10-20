import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// vi.hoisted for the same reason as tests/unit/manual-assets-env.test.ts: the static page import
// below is linked before this file's body runs, firing the mock factory.
const { results, calls, selects } = vi.hoisted(() => ({
  // Every `.select()` the page sends, per table, so a test can pin the suggestion embed (§7.4).
  selects: {} as Record<string, string[]>,
  results: {} as Record<string, { data: unknown; error: { message: string } | null }>,
  calls: { gte: [] as string[], lte: [] as string[] },
}))

// A supabase query is a builder that is awaited at the end, so the stub returns itself for every
// chained method and resolves to whatever the test configured for that table. `.gte`/`.lte` are
// recorded rather than just chained, since the date bounds the page hands the database are the
// whole behaviour under test in the 'Trends month window' block below.
const chainFor = (table: string) => {
  const chain: Record<string, unknown> = {}
  for (const method of ['select', 'order', 'eq', 'limit']) chain[method] = () => chain
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
  chain.lte = (_col: string, v: string) => {
    calls.lte.push(v)
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
        if (table !== 'plaid_items') throw new Error(`trends page read ${table} through the service-role client`)
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

import TrendsPage from '@/app/(app)/trends/page'
import { SpendByCategoryChart } from '@/components/SpendByCategoryChart'
import { NotSyncingBanner } from '@/components/NotSyncingBanner'
import { PageHeader } from '@/components/ui/PageHeader'
import { catalogFingerprint } from '@/lib/category-rules'
import { sug } from './helpers/category-context'
import { blocks, bannerText } from './helpers/banner'
import { storedItem, FOREIGN_ITEMS } from '../stubs/plaid-items'

const FOOD = { id: 'c-food', name: 'Food & Drink', pfc_primary: 'FOOD_AND_DRINK', sort_order: 0 }
const GROCERY = { id: 'c-grocery', name: 'Grocery', pfc_primary: null, sort_order: 1 }
const SAFEWAY_RULE = { id: 'r-safeway', household_id: 'hh-1', merchant_key: 'safeway', merchant_label: 'Safeway', category_id: 'c-grocery', origin: 'seeded' }

const ok = { data: [], error: null }

beforeEach(() => {
  results.categories = ok
  results.category_rules = ok
  results.transactions = ok
  results.households = { data: { timezone: 'America/New_York' }, error: null }
  results.memberships = { data: { household_id: 'hh-1' }, error: null }
  results.plaid_items = ok
  calls.gte = []
  calls.lte = []
  for (const k of Object.keys(selects)) delete selects[k]
  vi.unstubAllEnvs()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

// The dashboard's banner, above last month's spending and the month before's (#135).
describe('Trends banks (#135)', () => {
  it("warns that a bank isn't syncing, first, above the header", async () => {
    results.plaid_items = {
      data: [
        storedItem({ status: 'needs_reconnect' }),
        storedItem({ id: 'item-2', institution_name: 'Amex', status: 'action_at_bank' }),
        storedItem({ id: 'item-3', institution_name: 'Chase' }),
        ...FOREIGN_ITEMS,
      ],
      error: null,
    }
    const tree = await TrendsPage()
    expect(bannerText(tree)).toBe(
      "2 banks aren't syncing — reconnect in Settings to resume. These figures may be out of date."
    )
    const order = blocks(tree).map((b) => b.type)
    expect(order.indexOf(NotSyncingBanner)).toBe(0)
    expect(order.indexOf(PageHeader)).toBe(1)
  })

  // Another household's broken bank, or this household's from the other Plaid environment, must
  // not raise the banner here.
  it("says nothing while every one of the household's banks is syncing", async () => {
    results.plaid_items = { data: [storedItem(), ...FOREIGN_ITEMS], error: null }
    expect(bannerText(await TrendsPage())).toBe('')
  })

  // Rendered as no banks, a failed read would chart a broken bank's months with no warning (#46).
  // It throws, as the dashboard does, and app/(app)/error.tsx offers a retry.
  it('fails loudly when the banks read fails, rather than hiding the banner', async () => {
    results.plaid_items = { data: null, error: { message: 'statement timeout' } }
    await expect(TrendsPage()).rejects.toThrow(/could not read linked banks: statement timeout/)
  })

  it('fails loudly when the household read fails, rather than hiding the banner', async () => {
    results.memberships = { data: null, error: { message: 'permission denied' } }
    await expect(TrendsPage()).rejects.toThrow(/could not read your household: permission denied/)
  })
})

describe('Trends page reads', () => {
  // #46's lesson, and the reason this page must not swallow either error: app/(app)/error.tsx is
  // a route-segment boundary covering trends by name, so throwing shows a retryable "couldn't
  // load" with the sidebar intact — a strictly better outcome than a confident wrong number.
  it('fails loudly when the transactions read fails, rather than reporting no spending', async () => {
    results.transactions = { data: null, error: { message: 'statement timeout' } }
    await expect(TrendsPage()).rejects.toThrow(/could not read transactions: statement timeout/)
  })

  // This one is sharper than an empty chart. With no categories nothing maps to Income or
  // Transfer, so spendByCategory's exclusions never fire and a paycheck is charted as negative
  // spending under "Uncategorized" — a number the reader would believe.
  it('fails loudly when the categories read fails, rather than charting income as spending', async () => {
    results.categories = { data: null, error: { message: 'permission denied' } }
    await expect(TrendsPage()).rejects.toThrow(/could not read categories: permission denied/)
  })

  it('renders when both reads succeed', async () => {
    await expect(TrendsPage()).resolves.toBeTruthy()
  })
})

describe('Trends month window', () => {
  // At 8:10pm on 31 August the household is still in August, but the server's UTC clock has
  // already rolled to 1 September. `todayIn('UTC')` in place of the stored zone would report
  // August/July here — the mutation the final review proved invisible to every other guard on
  // this branch (#73).
  it('honours the household\'s stored zone, not the server\'s', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-01T00:10:00Z')) // 8:10pm on 31 August in New York
    results.households = { data: { timezone: 'America/New_York' }, error: null }
    await TrendsPage()
    expect(calls.gte).toContain('2026-06-01')
    expect(calls.lte).toContain('2026-07-31')
    // Under 'UTC' these would instead be '2026-07-01' and '2026-08-31' — a whole month later.
    expect(calls.gte).not.toContain('2026-07-01')
    expect(calls.lte).not.toContain('2026-08-31')
  })
})

// The chart's props, read straight off the unrendered Server Component tree.
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

describe('Trends categories and rules (#28)', () => {
  it('charts Safeway under Grocery through its rule', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-15T12:00:00Z')) // the last complete month is August
    results.categories = { data: [FOOD, GROCERY], error: null }
    results.category_rules = { data: [SAFEWAY_RULE], error: null }
    results.transactions = {
      data: [
        { id: 't1', amount: 42, date: '2026-08-10', merchant_name: 'Safeway', user_category: null, pfc_primary: 'FOOD_AND_DRINK', pfc_detailed: null, reimbursable_amount: null },
      ],
      error: null,
    }
    const chart = findProps(await TrendsPage(), SpendByCategoryChart) as { data: { category: string; amount: number }[] }
    expect(chart.data).toContainEqual({ category: 'Grocery', amount: 42 })
    expect(chart.data.some((r) => r.category === 'Food & Drink')).toBe(false)
  })

  // Spec §14.3/§14.7: a Whole Foods row with no rule takes Jev's confident suggestion, and only
  // while CATEGORY_SUGGESTIONS is on.
  const wholeFoods = (suggestion: unknown) => ({
    id: 't2', amount: 30, date: '2026-08-11', merchant_name: 'Whole Foods', user_category: null,
    pfc_primary: 'FOOD_AND_DRINK', pfc_detailed: null, reimbursable_amount: null, suggestion,
  })
  const chartWith = async (rows: unknown[]) => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-15T12:00:00Z')) // the last complete month is August
    results.categories = { data: [FOOD, GROCERY], error: null }
    results.category_rules = { data: [], error: null }
    results.transactions = { data: rows, error: null }
    return (findProps(await TrendsPage(), SpendByCategoryChart) as { data: { category: string; amount: number }[] }).data
  }

  it('charts Whole Foods under Grocery through its suggestion when suggestions are on', async () => {
    vi.stubEnv('CATEGORY_SUGGESTIONS', 'on')
    const data = await chartWith([wholeFoods(sug(GROCERY.id, 0.99, catalogFingerprint([FOOD, GROCERY])))])
    expect(data).toContainEqual({ category: 'Grocery', amount: 30 })
    expect(data.some((r) => r.category === 'Food & Drink')).toBe(false)
  })

  it('charts Whole Foods under Food & Drink when suggestions are off', async () => {
    vi.stubEnv('CATEGORY_SUGGESTIONS', undefined)
    const data = await chartWith([wholeFoods(sug(GROCERY.id, 0.99, catalogFingerprint([FOOD, GROCERY])))])
    expect(data).toContainEqual({ category: 'Food & Drink', amount: 30 })
    expect(data.some((r) => r.category === 'Grocery')).toBe(false)
  })

  // Review Focus 5: switching on changes nothing for rows that carry no suggestion.
  it('charts the same with the switch on as off when no row has a suggestion', async () => {
    const rows = [wholeFoods(null), { ...wholeFoods(null), id: 't3', merchant_name: 'Safeway', amount: 12 }]
    vi.stubEnv('CATEGORY_SUGGESTIONS', 'on')
    const on = await chartWith(rows)
    vi.stubEnv('CATEGORY_SUGGESTIONS', undefined)
    const off = await chartWith(rows)
    expect(on).toContainEqual({ category: 'Food & Drink', amount: 42 })
    expect(on).toEqual(off)
  })

  // Spec §7.4's coverage guard: every transactions read the page resolves carries the embed.
  it('selects each transaction\'s suggestion', async () => {
    await chartWith([wholeFoods(null)])
    expect(selects.transactions?.length).toBeGreaterThan(0)
    for (const cols of selects.transactions) expect(cols).toContain('category_suggestions(')
  })

  // A failed rules read rendered as "no rules" would quietly move every learned label back (#46).
  it('throws when the categories and rules cannot be read', async () => {
    results.category_rules = { data: null, error: { message: 'boom' } }
    await expect(TrendsPage()).rejects.toThrow(/could not read category rules/)
  })
})
