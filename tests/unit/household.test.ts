import { describe, it, expect, beforeEach, vi } from 'vitest'

// vi.hoisted for the same reason as tests/unit/manual-assets-env.test.ts: the static import below
// is linked before this file's body runs, firing the mock factory.
const { result } = vi.hoisted(() => ({
  result: {} as { data: unknown; error: { message: string } | null },
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    from: () => ({
      select: () => ({
        limit: () => ({
          maybeSingle: async () => result,
        }),
      }),
    }),
  }),
}))

import { householdTimezone, DEFAULT_TIMEZONE } from '@/lib/household'

beforeEach(() => {
  result.data = { timezone: 'America/Chicago' }
  result.error = null
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
