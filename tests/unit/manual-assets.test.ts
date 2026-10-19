import { describe, it, expect, vi, beforeEach } from 'vitest'

// The read behind the home value (#91). It goes through the service-role client, which bypasses
// RLS, so the household filter is the only thing scoping it. The stand-in is strict, as in
// tests/unit/categorize-route.test.ts (#99): the read resolves only through
// .from(…).select(…).eq(…).order(…), every call is recorded, and select() projects the fixture to
// the columns it was asked for, so a narrowed select cannot pass on the fixture's spare columns.
const { reply, calls } = vi.hoisted(() => ({
  reply: { value: { data: null as unknown, error: null as unknown } },
  calls: [] as unknown[][],
}))

const project = (rows: unknown, cols: string) =>
  Array.isArray(rows)
    ? rows.map((r: Record<string, unknown>) =>
        Object.fromEntries(cols.split(',').map((c) => c.trim()).filter((c) => c in r).map((c) => [c, r[c]]))
      )
    : rows

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      calls.push(['from', table])
      return {
        select: (cols: string) => {
          calls.push(['select', cols])
          return {
            eq: (col: string, value: unknown) => {
              calls.push(['eq', col, value])
              return {
                order: (by: string) => {
                  calls.push(['order', by])
                  return Promise.resolve({ ...reply.value, data: project(reply.value.data, cols) })
                },
              }
            },
          }
        },
      }
    },
  },
}))

import { listManualAssets } from '@/lib/manual-assets'

const HOME = { id: 'a1', name: 'Home', value: 750000, updated_at: '2026-10-01T12:00:00Z', household_id: 'hh-1' }

beforeEach(() => {
  calls.length = 0
  reply.value = { data: [HOME], error: null }
})

describe('listManualAssets', () => {
  it("reads the household's assets, by name", async () => {
    await expect(listManualAssets('hh-1')).resolves.toEqual([
      { id: 'a1', name: 'Home', value: 750000, updated_at: '2026-10-01T12:00:00Z' },
    ])
    expect(calls).toEqual([
      ['from', 'manual_assets'],
      ['select', 'id, name, value, updated_at'],
      ['eq', 'household_id', 'hh-1'],
      ['order', 'name'],
    ])
  })

  // The only empty list that is true: a household that has never entered a home value.
  it('returns an empty list for a household with none', async () => {
    reply.value = { data: [], error: null }
    await expect(listManualAssets('hh-1')).resolves.toEqual([])
  })

  // #91: returned as [], a failed read dropped the house from net worth while the mortgage stayed
  // counted as a debt, and Settings showed the home value as never entered.
  it.each([
    ['with a code', { message: 'canceling statement due to statement timeout', code: '57014' }, 'could not read manual assets: 57014 canceling statement due to statement timeout'],
    ['without a code', { message: 'fetch failed' }, 'could not read manual assets: fetch failed'],
  ])('throws, naming the read, when it fails %s', async (_name, error, message) => {
    reply.value = { data: null, error }
    await expect(listManualAssets('hh-1')).rejects.toThrow(new Error(message))
  })

  // No data and no error is not "no house" (#46), any more than an error is.
  it('throws when the read returns no data and no error', async () => {
    reply.value = { data: null, error: null }
    await expect(listManualAssets('hh-1')).rejects.toThrow(
      new Error('could not read manual assets: read returned no data and no error')
    )
  })
})
