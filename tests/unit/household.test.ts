import { describe, it, expect, beforeEach, vi } from 'vitest'

// vi.hoisted for the same reason as tests/unit/manual-assets-env.test.ts: the static import below
// is linked before this file's body runs, firing the mock factory.
const { result, asked } = vi.hoisted(() => ({
  result: {} as { data: unknown; error: { message: string; code?: string } | null },
  // Every read, as `table.columns`, so a test can pin which table a helper asks.
  asked: [] as string[],
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    from: (table: string) => ({
      select: (columns: string) => ({
        limit: () => {
          asked.push(`${table}.${columns}`)
          return { maybeSingle: async () => result, single: async () => result }
        },
      }),
    }),
  }),
}))

import { householdTimezone, currentHouseholdId, DEFAULT_TIMEZONE } from '@/lib/household'

beforeEach(() => {
  result.data = { timezone: 'America/Chicago' }
  result.error = null
  asked.length = 0
})

describe('householdTimezone', () => {
  it('returns what the household has stored', async () => {
    await expect(householdTimezone()).resolves.toBe('America/Chicago')
  })

  // #46's rule as it applies here: a failed read must not quietly become a default, because the
  // default silently changes which month the money tiles report.
  it('throws on a read error rather than falling back to the default', async () => {
    result.data = null
    result.error = { message: 'permission denied' }
    await expect(householdTimezone()).rejects.toThrow(/could not read the household timezone/)
  })

  // Distinct from a failure: a signed-in user with no household row yet is a real state, and the
  // default is the honest answer for it.
  it('falls back to the default when there is no household row', async () => {
    result.data = null
    result.error = null
    await expect(householdTimezone()).resolves.toBe(DEFAULT_TIMEZONE)
  })

  it('falls back to the default when the column is null', async () => {
    result.data = { timezone: null }
    await expect(householdTimezone()).resolves.toBe(DEFAULT_TIMEZONE)
  })
})

// The household the service-role reads are scoped to (#135). Every page that shows the "isn't
// syncing" banner asks it which household's banks to read.
describe('currentHouseholdId', () => {
  it("returns the signed-in person's household, from their membership", async () => {
    result.data = { household_id: 'hh-1' }
    await expect(currentHouseholdId()).resolves.toBe('hh-1')
    expect(asked).toEqual(['memberships.household_id'])
  })

  // Unlike the timezone, there is no default to fall back on: without the household no page can
  // ask which banks are syncing, and no banks would hide the banner (#46).
  it.each([
    ['with a code', { message: 'permission denied', code: '42501' }, 'could not read your household: 42501 permission denied'],
    ['without a code', { message: 'fetch failed' }, 'could not read your household: fetch failed'],
  ])('throws, naming the read, when it fails %s', async (_name, error, message) => {
    result.data = null
    result.error = error
    await expect(currentHouseholdId()).rejects.toThrow(new Error(message))
  })

  it('throws when the read returns no data and no error', async () => {
    result.data = null
    result.error = null
    await expect(currentHouseholdId()).rejects.toThrow(
      new Error('could not read your household: read returned no data and no error')
    )
  })
})
