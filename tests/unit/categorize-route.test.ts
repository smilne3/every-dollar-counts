import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The only route that sets a category on one transaction (#28 spec §6.1, PR 1). The stand-in is
// strict on purpose, because a permissive one hid three dead guards here before (#99):
// - select() PROJECTS the fixture to the requested columns, so a narrowed read starves the guards;
// - the categories read only resolves through .eq('household_id', …).order('sort_order');
// - update() only resolves after .eq('id') → .eq('removed', false) → .or(<card-payment filter>),
//   so a write missing any guard cannot produce a result at all.
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))

import { AuthRetryableFetchError, AuthSessionMissingError, type AuthError } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { POST } from '@/app/api/transactions/categorize/route'

type Row = Record<string, unknown>
type Err = { message: string } | null

function project(data: Row | null, columns: string): Row | null {
  if (!data) return data
  const out: Row = {}
  for (const c of columns.split(',').map((s) => s.trim())) if (c in data) out[c] = data[c]
  return out
}

const CARD_FILTER = 'pfc_detailed.is.null,pfc_detailed.neq.LOAN_PAYMENTS_CREDIT_CARD_PAYMENT'

function makeSupabase({
  user = { id: 'user-1' } as { id: string } | null,
  authError = null as AuthError | null,
  row = null as Row | null,
  readError = null as Err,
  categories = [
    { id: 'c1', name: 'Food & Drink', pfc_primary: 'FOOD_AND_DRINK', sort_order: 1 },
    { id: 'c2', name: 'Grocery', pfc_primary: null, sort_order: 2 },
  ] as Row[] | null,
  categoriesError = null as Err,
  update = { error: null as Err, count: 1 as number | null },
}: Partial<{
  user: { id: string } | null
  authError: AuthError | null
  row: Row | null
  readError: Err
  categories: Row[] | null
  categoriesError: Err
  update: { error: Err; count: number | null }
}> = {}) {
  const calls = {
    readColumns: '' as string,
    categories: [] as unknown[][],
    updates: [] as { payload: Row; options: unknown; filters: unknown[][] }[],
  }
  const client = {
    // getUser answers { user: null, error } on ANY auth failure, a dropped connection included.
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user }, error: authError }) },
    from: vi.fn((table: string) => {
      if (table === 'categories') {
        return {
          select: (cols: string) => {
            calls.categories.push(['select', cols])
            return {
              eq: (c: string, v: unknown) => {
                calls.categories.push(['eq', c, v])
                return {
                  order: (c2: string) => {
                    calls.categories.push(['order', c2])
                    return Promise.resolve({ data: categories, error: categoriesError })
                  },
                }
              },
            }
          },
        }
      }
      return {
        select: (cols: string) => {
          calls.readColumns = cols
          return { eq: () => ({ maybeSingle: () => Promise.resolve({ data: project(row, cols), error: readError }) }) }
        },
        update: (payload: Row, options: unknown) => {
          const entry = { payload, options, filters: [] as unknown[][] }
          calls.updates.push(entry)
          return {
            eq: (c1: string, v1: unknown) => {
              entry.filters.push(['eq', c1, v1])
              return {
                eq: (c2: string, v2: unknown) => {
                  entry.filters.push(['eq', c2, v2])
                  return {
                    or: (f: string) => {
                      entry.filters.push(['or', f])
                      return Promise.resolve(update)
                    },
                  }
                },
              }
            },
          }
        },
      }
    }),
  }
  vi.mocked(createClient).mockResolvedValue(client as never)
  return calls
}

const ROW = {
  id: 'txn-1',
  household_id: 'hh-1',
  merchant_name: 'Safeway',
  pfc_primary: 'FOOD_AND_DRINK',
  pfc_detailed: 'FOOD_AND_DRINK_GROCERIES',
  removed: false,
  user_category: null,
}

const post = (body: unknown) =>
  POST(new Request('http://localhost/api/transactions/categorize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }))

let logs: unknown[][]
beforeEach(() => {
  vi.mocked(createClient).mockReset()
  logs = []
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation((...a) => void logs.push(a))
})
afterEach(() => vi.restoreAllMocks())

describe('POST /api/transactions/categorize: validation before the database', () => {
  it.each([
    ['malformed JSON', '{not json'],
    ['no transactionId', { category: 'Grocery' }],
    ['an empty category', { transactionId: 'txn-1', category: '' }],
    ['a whitespace-only category', { transactionId: 'txn-1', category: '   ' }],
  ])('answers 400 for %s without touching the database', async (_, body) => {
    const res = await post(body)
    expect(res.status).toBe(400)
    expect(createClient).not.toHaveBeenCalled()
  })
})

describe('POST /api/transactions/categorize', () => {
  it('answers 401 without a user, with a readable message', async () => {
    makeSupabase({ user: null })
    const res = await post({ transactionId: 'txn-1', category: 'Grocery' })
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe('Your session ended. Sign in again.')
  })

  // What supabase-js returns for a request with no session cookie, or one whose session was ended.
  it('answers 401 when the auth error is a missing session', async () => {
    const calls = makeSupabase({ user: null, authError: new AuthSessionMissingError() })
    const res = await post({ transactionId: 'txn-1', category: 'Grocery' })
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe('Your session ended. Sign in again.')
    expect(calls.updates).toHaveLength(0)
  })

  // Supabase Auth unreachable is not a signed-out person: telling them to sign in again would send
  // them round a login that does not fix anything.
  it('answers 503 and logs when the auth check itself fails', async () => {
    const calls = makeSupabase({ user: null, authError: new AuthRetryableFetchError('fetch failed', 0) })
    const res = await post({ transactionId: 'txn-1', category: 'Grocery' })
    expect(res.status).toBe(503)
    expect((await res.json()).error).toBe('That could not be saved. Please try again.')
    expect(console.error).toHaveBeenCalledWith('[categorize] auth check failed', 'fetch failed')
    expect(calls.updates).toHaveLength(0)
  })

  it('answers 500, not 404, when the read fails, and writes nothing', async () => {
    const calls = makeSupabase({ readError: { message: 'boom' } })
    const res = await post({ transactionId: 'txn-1', category: 'Grocery' })
    expect(res.status).toBe(500)
    expect(calls.updates).toHaveLength(0)
  })

  it('answers 404 when the transaction does not exist', async () => {
    makeSupabase({ row: null })
    expect((await post({ transactionId: 'txn-1', category: 'Grocery' })).status).toBe(404)
  })

  it('reads every column the later steps need', async () => {
    const calls = makeSupabase({ row: ROW })
    await post({ transactionId: 'txn-1', category: 'Grocery' })
    for (const col of ['id', 'household_id', 'merchant_name', 'pfc_primary', 'pfc_detailed', 'removed', 'user_category']) {
      expect(calls.readColumns.split(',').map((c) => c.trim())).toContain(col)
    }
  })

  it('answers 400 for a row the bank removed, and writes nothing', async () => {
    const calls = makeSupabase({ row: { ...ROW, removed: true } })
    const res = await post({ transactionId: 'txn-1', category: 'Grocery' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Your bank removed that transaction. Refresh and try again.')
    expect(calls.updates).toHaveLength(0)
  })

  // #59: any user_category on a card payment re-enters it into every total.
  it.each([
    ['an unpicked card payment', null],
    ['a card payment someone already filed by hand', 'Shopping'],
  ])('answers 400 for %s, and writes nothing', async (_, pick) => {
    const calls = makeSupabase({
      row: { ...ROW, pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', user_category: pick },
    })
    const res = await post({ transactionId: 'txn-1', category: 'Grocery' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('A credit-card payment is already kept out of spending and income.')
    expect(calls.updates).toHaveLength(0)
  })

  it("reads the row's household's categories, in order", async () => {
    const calls = makeSupabase({ row: ROW })
    await post({ transactionId: 'txn-1', category: 'Grocery' })
    expect(calls.categories).toEqual([
      ['select', 'id, name, pfc_primary, sort_order'],
      ['eq', 'household_id', 'hh-1'],
      ['order', 'sort_order'],
    ])
  })

  it('answers 500 when the categories read fails, and writes nothing', async () => {
    const calls = makeSupabase({ row: ROW, categoriesError: { message: 'boom' } })
    const res = await post({ transactionId: 'txn-1', category: 'Grocery' })
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('That could not be saved. Please try again.')
    expect(calls.updates).toHaveLength(0)
  })

  // Spec decision 7: clearing is not supported; 'Uncategorized' is a display name, not a category.
  it.each(['Uncategorized', 'Not A Category'])('answers 400 for %s, and writes nothing', async (category) => {
    const calls = makeSupabase({ row: ROW })
    const res = await post({ transactionId: 'txn-1', category })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('That category no longer exists. Refresh and try again.')
    expect(calls.updates).toHaveLength(0)
  })

  it('writes the category with every guard inside the update', async () => {
    const calls = makeSupabase({ row: ROW })
    const res = await post({ transactionId: 'txn-1', category: '  Grocery  ' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(calls.updates).toEqual([
      {
        payload: { user_category: 'Grocery' },
        options: { count: 'exact' },
        filters: [['eq', 'id', 'txn-1'], ['eq', 'removed', false], ['or', CARD_FILTER]],
      },
    ])
  })

  it('answers 500 for a failed write, without the database text', async () => {
    makeSupabase({ row: ROW, update: { error: { message: 'new row violates row-level security' }, count: null } })
    const res = await post({ transactionId: 'txn-1', category: 'Grocery' })
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('That could not be saved. Please try again.')
  })

  // The row changed between the read and the write: Plaid removed or re-tagged it.
  it('answers 409 when the write matched no rows', async () => {
    makeSupabase({ row: ROW, update: { error: null, count: 0 } })
    const res = await post({ transactionId: 'txn-1', category: 'Grocery' })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('This transaction just changed. Refresh and try again.')
  })

  // A count the server did not send is not a count of one. Treating it as a write would report a
  // save that may never have happened.
  it('answers 409 when the write returns no count', async () => {
    makeSupabase({ row: ROW, update: { error: null, count: null } })
    const res = await post({ transactionId: 'txn-1', category: 'Grocery' })
    expect(res.status).toBe(409)
  })

  // Category names match exactly, as stored. A near-miss is not that category.
  it('answers 400 for a category in the wrong case, and writes nothing', async () => {
    const calls = makeSupabase({ row: ROW })
    const res = await post({ transactionId: 'txn-1', category: 'grocery' })
    expect(res.status).toBe(400)
    expect(calls.updates).toHaveLength(0)
  })

  // Spec §6.1 step 7: so a mistaken pick can be recovered from the logs.
  it('logs the previous and new category', async () => {
    makeSupabase({ row: { ...ROW, user_category: 'Food & Drink' } })
    await post({ transactionId: 'txn-1', category: 'Grocery' })
    expect(logs).toContainEqual(['[categorize] changed', { id: 'txn-1', from: 'Food & Drink', to: 'Grocery' }])
  })

  // The change log is the record of what was written; a write that did not happen must not be in it.
  it.each([
    ['a write that matched no rows', { error: null, count: 0 }],
    ['a failed write', { error: { message: 'boom' }, count: null }],
  ])('logs no change for %s', async (_, update) => {
    makeSupabase({ row: ROW, update })
    await post({ transactionId: 'txn-1', category: 'Grocery' })
    expect(logs.some((l) => l[0] === '[categorize] changed')).toBe(false)
  })
})
