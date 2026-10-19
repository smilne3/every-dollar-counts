import { describe, it, expect, vi, beforeEach } from 'vitest'

// The read behind the dashboard's "isn't syncing" banner and Settings' bank list (#91). It goes
// through the service-role client, which bypasses RLS, so the household filter is the only thing
// scoping it. The stand-in is strict, as in tests/unit/categorize-route.test.ts (#99): the read
// resolves only through .from(…).select(…).eq(…).eq(…).order(…), every call is recorded, and
// select() projects the fixture to the columns it was asked for.
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
            eq: (c1: string, v1: unknown) => {
              calls.push(['eq', c1, v1])
              return {
                eq: (c2: string, v2: unknown) => {
                  calls.push(['eq', c2, v2])
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
      }
    },
  },
}))
// Not the suite's PLAID_ENV ('sandbox'), so the filter has to come from lib/plaid.
vi.mock('@/lib/plaid', () => ({ plaidEnv: 'production' }))

import { listItemsForHousehold } from '@/lib/plaid-items'

// As stored, token included: the select must leave it behind.
const ITEM = {
  id: 'item-1',
  household_id: 'hh-1',
  institution_name: 'Capital One',
  status: 'needs_reconnect',
  status_detail: 'ITEM_LOGIN_REQUIRED',
  products: ['transactions'],
  created_at: '2026-07-14T18:05:30Z',
  plaid_env: 'production',
  access_token_encrypted: 'cipher',
}

beforeEach(() => {
  calls.length = 0
  reply.value = { data: [ITEM], error: null }
})

describe('listItemsForHousehold', () => {
  it("reads the household's banks in this environment, oldest first", async () => {
    await expect(listItemsForHousehold('hh-1')).resolves.toEqual([
      {
        id: 'item-1',
        institution_name: 'Capital One',
        status: 'needs_reconnect',
        status_detail: 'ITEM_LOGIN_REQUIRED',
        products: ['transactions'],
        created_at: '2026-07-14T18:05:30Z',
      },
    ])
    expect(calls).toEqual([
      ['from', 'plaid_items'],
      ['select', 'id, institution_name, status, status_detail, products, created_at'],
      ['eq', 'household_id', 'hh-1'],
      ['eq', 'plaid_env', 'production'],
      ['order', 'created_at'],
    ])
  })

  // The only empty list that is true: a household that has not linked a bank.
  it('returns an empty list for a household with no banks', async () => {
    reply.value = { data: [], error: null }
    await expect(listItemsForHousehold('hh-1')).resolves.toEqual([])
  })

  // #91: returned as [], a failed read hid the dashboard's "isn't syncing" banner, and Settings said
  // "No banks connected yet." beside the button that spends one of ten lifetime connections (#51).
  it.each([
    ['with a code', { message: 'canceling statement due to statement timeout', code: '57014' }, 'could not read linked banks: 57014 canceling statement due to statement timeout'],
    ['without a code', { message: 'fetch failed' }, 'could not read linked banks: fetch failed'],
  ])('throws, naming the read, when it fails %s', async (_name, error, message) => {
    reply.value = { data: null, error }
    await expect(listItemsForHousehold('hh-1')).rejects.toThrow(new Error(message))
  })

  // No data and no error is not "no banks" (#46), any more than an error is.
  it('throws when the read returns no data and no error', async () => {
    reply.value = { data: null, error: null }
    await expect(listItemsForHousehold('hh-1')).rejects.toThrow(
      new Error('could not read linked banks: read returned no data and no error')
    )
  })
})
