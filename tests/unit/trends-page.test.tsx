import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// vi.hoisted for the same reason as tests/unit/manual-assets-env.test.ts: the static page import
// below is linked before this file's body runs, firing the mock factory.
const { results, calls } = vi.hoisted(() => ({
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
  chain.gte = (_col: string, v: string) => {
    calls.gte.push(v)
    return chain
  }
  chain.lte = (_col: string, v: string) => {
    calls.lte.push(v)
    return chain
  }
  chain.maybeSingle = async () => results[table] ?? { data: null, error: null }
  chain.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(results[table] ?? { data: [], error: null }).then(resolve)
  return chain
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ from: (table: string) => chainFor(table) }),
}))

import TrendsPage from '@/app/(app)/trends/page'

const ok = { data: [], error: null }

beforeEach(() => {
  results.categories = ok
  results.transactions = ok
  results.households = { data: { timezone: 'America/New_York' }, error: null }
  calls.gte = []
  calls.lte = []
})

afterEach(() => {
  vi.useRealTimers()
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
