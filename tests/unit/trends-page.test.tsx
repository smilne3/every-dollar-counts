import { describe, it, expect, beforeEach, vi } from 'vitest'

// vi.hoisted for the same reason as tests/unit/manual-assets-env.test.ts: the static page import
// below is linked before this file's body runs, firing the mock factory.
const { results } = vi.hoisted(() => ({
  results: {} as Record<string, { data: unknown; error: { message: string } | null }>,
}))

// A supabase query is a builder that is awaited at the end, so the stub returns itself for every
// chained method and resolves to whatever the test configured for that table.
const chainFor = (table: string) => {
  const chain: Record<string, unknown> = {}
  for (const method of ['select', 'order', 'eq', 'gte', 'lte']) chain[method] = () => chain
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
