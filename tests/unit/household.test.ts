import { describe, it, expect, beforeEach, vi } from 'vitest'

// vi.hoisted for the same reason as tests/unit/manual-assets-env.test.ts: the static import below
// is linked before this file's body runs, firing the mock factory.
const { result, asked } = vi.hoisted(() => ({
  // What the table answers, as PostgREST sends it: the rows, or null data for an empty body (a 200
  // or a 404 with nothing in it), which postgrest-js passes on as null data and no error (#222).
  result: {} as { data: Record<string, unknown>[] | null; error: { message: string; code?: string } | null },
  // Every read, as `table.columns`, so a test can pin which table a helper asks.
  asked: [] as string[],
}))

// Each way of reading answers as postgrest-js would from `result`:
// - awaited as is, the rows, or null data for an empty body;
// - .maybeSingle(), the row, or null data for no row. An empty body gives null data too, which is
//   why the helpers can't tell a failed read from no row through it (#222);
// - .single(), no row as a 406 with PGRST116, never null data and no error. A stand-in that answered
//   .single() with null data hid that a "no row" guard behind it could never run (#172).
const noRow = { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' }
const one = (empty: { data: null; error: typeof noRow | null }) =>
  result.error || result.data === null
    ? { data: null, error: result.error }
    : result.data.length === 1
      ? { data: result.data[0], error: null }
      : result.data.length === 0
        ? empty
        : { data: null, error: noRow }

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    from: (table: string) => ({
      select: (columns: string) => ({
        limit: () => {
          asked.push(`${table}.${columns}`)
          return {
            then: (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve),
            maybeSingle: async () => one({ data: null, error: null }),
            single: async () => one({ data: null, error: noRow }),
          }
        },
      }),
    }),
  }),
}))

import { householdTimezone, currentHouseholdId, DEFAULT_TIMEZONE } from '@/lib/household'

beforeEach(() => {
  result.data = [{ timezone: 'America/Chicago' }]
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
    result.data = []
    await expect(householdTimezone()).resolves.toBe(DEFAULT_TIMEZONE)
  })

  // #222: an empty body is no answer, not "no row". As the default it would pick the month the
  // tiles report, the same confident wrong number as a failed read.
  it('throws, naming the read, when it answers with no data and no error', async () => {
    result.data = null
    result.error = null
    await expect(householdTimezone()).rejects.toThrow(
      new Error('could not read the household timezone: read returned no data and no error'),
    )
  })

  it('falls back to the default when the column is null', async () => {
    result.data = [{ timezone: null }]
    await expect(householdTimezone()).resolves.toBe(DEFAULT_TIMEZONE)
  })
})

// The household the service-role reads are scoped to (#135). Every page that shows the "isn't
// syncing" banner asks it which household's banks to read.
describe('currentHouseholdId', () => {
  it("returns the signed-in person's household, from their membership", async () => {
    result.data = [{ household_id: 'hh-1' }]
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

  // #172: sign-in lets an account with no membership through when it can't read the membership
  // (lib/access.ts).
  // That account has no household, so no banks: a true answer, not a failed read, and the pages
  // render for it. As an error it put them on the error page on every visit.
  it('returns null for an account with no household, rather than failing', async () => {
    result.data = []
    await expect(currentHouseholdId()).resolves.toBeNull()
    expect(asked).toEqual(['memberships.household_id'])
  })

  // #222: an empty body is no answer, not "no household". Read as no household, the Dashboard
  // showed Net worth without the banks or the house, and hid the "isn't syncing" banner.
  it('throws, naming the read, when it answers with no data and no error', async () => {
    result.data = null
    result.error = null
    await expect(currentHouseholdId()).rejects.toThrow(
      new Error('could not read your household: read returned no data and no error'),
    )
  })
})
