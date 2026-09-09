import { describe, it, expect, beforeEach, vi } from 'vitest'

const { calls, tz } = vi.hoisted(() => ({
  calls: { gte: [] as string[], lt: [] as string[] },
  tz: { value: 'America/New_York' },
}))

// Record the date bounds the page asks the database for — that is the whole behaviour under test.
const chainFor = () => {
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'order', 'eq']) chain[m] = () => chain
  chain.gte = (_col: string, v: string) => {
    calls.gte.push(v)
    return chain
  }
  chain.lt = (_col: string, v: string) => {
    calls.lt.push(v)
    return chain
  }
  chain.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve({ data: [], error: null }).then(resolve)
  return chain
}

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ from: () => chainFor() }) }))
vi.mock('@/lib/household', () => ({
  DEFAULT_TIMEZONE: 'America/New_York',
  householdTimezone: async () => tz.value,
}))

import BudgetsPage from '@/app/(app)/budgets/page'

beforeEach(() => {
  vi.useFakeTimers()
  calls.gte = []
  calls.lt = []
  tz.value = 'America/New_York'
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
