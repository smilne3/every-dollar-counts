import { describe, it, expect, beforeEach, vi } from 'vitest'

// vi.hoisted for the same reason as tests/unit/budgets-page.test.tsx and tests/unit/trends-page.test.tsx:
// the static page import below is linked before this file's body runs, firing the mock factory.
const { results, calls, tz } = vi.hoisted(() => ({
  results: {} as Record<string, { data: unknown; error: { message: string } | null }>,
  calls: { gte: [] as string[] },
  tz: { value: 'America/New_York' },
}))

// A supabase query is a builder awaited at the end, so the stub returns itself for every chained
// method and resolves to whatever the test configured for that table. `.gte` is recorded rather
// than just chained, since the date bound it's given is the whole behaviour under test here.
const chainFor = (table: string) => {
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'order', 'eq', 'lte', 'limit', 'not']) chain[m] = () => chain
  chain.gte = (_col: string, v: string) => {
    calls.gte.push(v)
    return chain
  }
  chain.single = async () => results[table] ?? { data: null, error: null }
  chain.maybeSingle = async () => results[table] ?? { data: null, error: null }
  chain.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(results[table] ?? { data: [], error: null }).then(resolve)
  return chain
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ from: (table: string) => chainFor(table) }),
}))
vi.mock('@/lib/household', () => ({
  DEFAULT_TIMEZONE: 'America/New_York',
  householdTimezone: async () => tz.value,
}))
vi.mock('@/lib/manual-assets', () => ({ listManualAssets: async () => [] }))
vi.mock('@/lib/receivable', () => ({ fetchReceivable: async () => 0 }))

import BreakdownPage from '@/app/(app)/breakdown/[metric]/page'

const render = (metric: string) => BreakdownPage({ params: Promise.resolve({ metric }) })

beforeEach(() => {
  vi.useFakeTimers()
  calls.gte = []
  tz.value = 'America/New_York'
  results.accounts = { data: [], error: null }
  results.memberships = { data: { household_id: 'hh-1' }, error: null }
  results.categories = { data: [], error: null }
  results.transactions = { data: [], error: null }
})

// net-worth and cash never touch a date — only spent and saved read the household's month, and
// only those two are exercised below.
describe('Breakdown month window', () => {
  // Same trap as Budgets (#73), on a page Budgets doesn't share: at 8:10pm on 31 August the server
  // is already in September. This page's month key also gets embedded in the outbound
  // /transactions?...&month= links rendered below it, so a wrong month here leaks into a second
  // page's filter, silently.
  it('uses the household\'s month, not the server\'s, for the spent metric', async () => {
    vi.setSystemTime(new Date('2026-09-01T00:10:00Z')) // 8:10pm on 31 August in New York
    await render('spent')
    expect(calls.gte).toContain('2026-08-01')
    expect(calls.gte).not.toContain('2026-09-01')
  })

  it('uses the household\'s month, not the server\'s, for the saved metric', async () => {
    vi.setSystemTime(new Date('2026-09-01T00:10:00Z'))
    await render('saved')
    expect(calls.gte).toContain('2026-08-01')
    expect(calls.gte).not.toContain('2026-09-01')
  })

  it('rolls over when the household\'s month actually changes', async () => {
    vi.setSystemTime(new Date('2026-09-01T12:00:00Z')) // 8am on 1 September in New York
    await render('spent')
    expect(calls.gte).toContain('2026-09-01')
  })

  it('crosses a year boundary correctly', async () => {
    vi.setSystemTime(new Date('2026-12-15T12:00:00Z'))
    await render('spent')
    expect(calls.gte).toContain('2026-12-01')
  })
})
