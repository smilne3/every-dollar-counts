import { describe, it, expect, beforeEach, vi } from 'vitest'

const { calls, tz, results } = vi.hoisted(() => ({
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
  chain.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(
      afterCursor ? { data: [], error: null } : (results[table] ?? { data: [], error: null })
    ).then(resolve)
  return chain
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ from: (table: string) => chainFor(table) }),
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
vi.mock('@/lib/household', () => ({
  DEFAULT_TIMEZONE: 'America/New_York',
  householdTimezone: async () => tz.value,
}))

import BudgetsPage from '@/app/(app)/budgets/page'
import { BudgetEditor } from '@/components/BudgetEditor'

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

  // A failed rules read rendered as "no rules" would quietly move every learned label back (#46).
  it('throws when the categories and rules cannot be read', async () => {
    vi.setSystemTime(new Date('2026-09-15T12:00:00Z'))
    results.category_rules = { data: null, error: { message: 'boom' } }
    await expect(BudgetsPage()).rejects.toThrow(/could not read category rules/)
  })
})
