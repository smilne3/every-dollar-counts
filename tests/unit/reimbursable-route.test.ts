import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// app/api/reimbursable/route.ts is the ONLY writer of reimbursable_amount / reimbursable_note. It
// holds load-bearing guards: refuse a credit-card payment (#31), refuse a `removed` transaction,
// fail CLOSED on a read error, and refuse a write that matched no row, which is how #73 hid. Its
// messages reach the person verbatim (ReimbursableCheckbox, ReimbursableEditor), so none may carry
// the database's words.
//
// The stand-in is strict on purpose (#101). The old one ignored the columns asked for and resolved
// an update that was never narrowed, so narrowing the read or dropping the update's .eq() left the
// suite green. This one, like tests/unit/categorize-route.test.ts:
// - projects the fixture to the columns the read asks for, so a narrowed read starves the guards;
// - matches rows the way the database would, on the column and value it is given;
// - makes update() reachable only through .eq(), so an unscoped update cannot produce a result;
// - returns a count only when { count: 'exact' } is asked for, as PostgREST does.
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))

import { AuthRetryableFetchError, type AuthError } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { PATCH } from '@/app/api/reimbursable/route'

type Row = Record<string, unknown>
type DbError = { code?: string; message: string } | null

const TXN: Row = {
  id: 'txn-1',
  household_id: 'hh-1',
  amount: 900,
  removed: false,
  pfc_detailed: null,
  user_category: null,
  reimbursable_amount: null,
  reimbursable_note: null,
}

function project(data: Row | null, columns: string): Row | null {
  if (!data) return data
  const out: Row = {}
  for (const c of columns.split(',').map((s) => s.trim())) if (c in data) out[c] = data[c]
  return out
}

function makeSupabase({
  user = { id: 'user-1' } as { id: string } | null,
  authError = null as AuthError | null,
  row = TXN as Row | null,
  readError = null as DbError,
  update = { error: null as DbError, count: 1 as number | null },
} = {}) {
  const calls = {
    reads: [] as unknown[][],
    updates: [] as { payload: Row; options: unknown; filters: unknown[][] }[],
  }
  const matches = (col: string, val: unknown) => row !== null && col in row && row[col] === val
  const client = {
    // getUser answers { user: null, error } on ANY auth failure, a dropped connection included.
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user }, error: authError }) },
    from: vi.fn((table: string) => {
      if (table !== 'transactions') throw new Error(`unexpected table ${table}`)
      return {
        select: (cols: string) => {
          calls.reads.push(['select', cols])
          return {
            eq: (col: string, val: unknown) => {
              calls.reads.push(['eq', col, val])
              return {
                maybeSingle: () =>
                  Promise.resolve({ data: readError ? null : project(matches(col, val) ? row : null, cols), error: readError }),
              }
            },
          }
        },
        update: (payload: Row, options?: { count?: string }) => {
          const entry = { payload, options, filters: [] as unknown[][] }
          calls.updates.push(entry)
          return {
            eq: (col: string, val: unknown) => {
              entry.filters.push(['eq', col, val])
              const result = update.error ? update : matches(col, val) ? update : { error: null, count: 0 }
              return Promise.resolve(options?.count === 'exact' ? result : { ...result, count: null })
            },
          }
        },
      }
    }),
  }
  vi.mocked(createClient).mockResolvedValue(client as never)
  return calls
}

const patch = (body: unknown) =>
  PATCH(
    new Request('http://localhost/api/reimbursable', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  )
const mark = (over: Record<string, unknown> = {}) => patch({ transactionId: 'txn-1', amount: 500, note: null, ...over })
const errorOf = async (res: Response) => (await res.json()).error

const TRY_AGAIN = 'That could not be saved. Please try again.'

let logs: unknown[][]
beforeEach(() => {
  vi.mocked(createClient).mockReset()
  logs = []
  vi.spyOn(console, 'error').mockImplementation((...a) => void logs.push(a))
})
afterEach(() => vi.restoreAllMocks())

describe('PATCH /api/reimbursable: validation before the database', () => {
  it.each([
    ['malformed JSON', '{not json'],
    ['no transactionId', { amount: 500, note: null }],
    ['a transactionId that is not a string', { transactionId: 7, amount: 500, note: null }],
  ])('answers 400 for %s, in words, without touching the database', async (_, body) => {
    const res = await patch(body)
    expect(res.status).toBe(400)
    expect(await errorOf(res)).toBe('That could not be saved. Refresh and try again.')
    expect(createClient).not.toHaveBeenCalled()
  })
})

describe('PATCH /api/reimbursable', () => {
  it('answers 401 without a user, in words, and writes nothing', async () => {
    const calls = makeSupabase({ user: null })
    const res = await mark()
    expect(res.status).toBe(401)
    expect(await errorOf(res)).toBe('Your session ended. Sign in again.')
    expect(calls.updates).toHaveLength(0)
  })

  // Supabase Auth unreachable is not a signed-out person: "sign in again" would not fix anything.
  it('answers 503 and logs when the auth check itself fails, and writes nothing', async () => {
    const authError = new AuthRetryableFetchError('fetch failed', 0)
    const calls = makeSupabase({ user: null, authError })
    const res = await mark()
    expect(res.status).toBe(503)
    expect(await errorOf(res)).toBe(TRY_AGAIN)
    expect(logs).toContainEqual(['[reimbursable] auth check failed', { code: authError.code, message: 'fetch failed' }])
    expect(calls.updates).toHaveLength(0)
  })

  // Fail CLOSED: "the query failed" and "no such transaction" are different facts.
  it('answers 500, not 404, when the read fails, logs the database text and does not show it', async () => {
    const calls = makeSupabase({ readError: { code: '57014', message: 'canceling statement due to statement timeout' } })
    const res = await mark()
    expect(res.status).toBe(500)
    expect(await errorOf(res)).toBe(TRY_AGAIN)
    expect(logs).toContainEqual([
      '[reimbursable] transaction read failed',
      { id: 'txn-1', code: '57014', message: 'canceling statement due to statement timeout' },
    ])
    expect(calls.updates).toHaveLength(0)
  })

  it('reads the transaction it was given, by id', async () => {
    const calls = makeSupabase()
    await mark()
    expect(calls.reads.filter((c) => c[0] === 'eq')).toEqual([['eq', 'id', 'txn-1']])
  })

  it('answers 404 in words when the transaction does not exist, and writes nothing', async () => {
    const calls = makeSupabase({ row: null })
    const res = await mark()
    expect(res.status).toBe(404)
    expect(await errorOf(res)).toBe('That transaction no longer exists. Refresh and try again.')
    expect(calls.updates).toHaveLength(0)
  })

  // `removed` is a soft flag (a Plaid repost), not a delete. A mark written to a removed row would be
  // unreachable while still counting toward what you're owed.
  it('answers 400 for a transaction the bank removed, and writes nothing', async () => {
    const calls = makeSupabase({ row: { ...TXN, removed: true } })
    const res = await mark()
    expect(res.status).toBe(400)
    expect(await errorOf(res)).toBe('Your bank removed that transaction. Refresh and try again.')
    expect(calls.updates).toHaveLength(0)
  })

  // Guards #31: a credit-card payment is already excluded from spending, so marking it reduces
  // nothing while still inflating what you're owed.
  it('answers 400 for a credit-card payment, and writes nothing', async () => {
    const calls = makeSupabase({ row: { ...TXN, pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' } })
    const res = await mark()
    expect(res.status).toBe(400)
    expect(await errorOf(res)).toBe('A credit-card payment is already kept out of spending and income.')
    expect(calls.updates).toHaveLength(0)
  })

  // A card payment someone filed under a category counts as that category, so it can be marked
  // (isCreditCardPayment). This also fails if the read stops asking for user_category.
  it('marks a credit-card payment that carries a pick', async () => {
    const calls = makeSupabase({ row: { ...TXN, pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', user_category: 'Shopping' } })
    const res = await mark()
    expect(res.status).toBe(200)
    expect(calls.updates).toHaveLength(1)
  })

  it('writes the clamped amount and the trimmed note, counted and filtered on the id', async () => {
    const calls = makeSupabase()
    // $5,000 requested on a $900 transaction: clamped to 900, never stored raw.
    const res = await mark({ amount: 5000, note: '  Dave ' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(calls.updates).toEqual([
      {
        payload: { reimbursable_amount: 900, reimbursable_note: 'Dave' },
        options: { count: 'exact' },
        filters: [['eq', 'id', 'txn-1']],
      },
    ])
  })

  it('clears the mark and its note', async () => {
    const calls = makeSupabase({ row: { ...TXN, reimbursable_amount: 900, reimbursable_note: 'Dave' } })
    const res = await mark({ amount: null, note: null })
    expect(res.status).toBe(200)
    expect(calls.updates[0].payload).toEqual({ reimbursable_amount: null, reimbursable_note: null })
  })

  it('answers 500 for a failed write, logs the database text and does not show it', async () => {
    makeSupabase({ update: { error: { code: '42501', message: 'new row violates row-level security policy' }, count: null } })
    const res = await mark()
    expect(res.status).toBe(500)
    expect(await errorOf(res)).toBe(TRY_AGAIN)
    expect(logs).toContainEqual([
      '[reimbursable] update failed',
      { id: 'txn-1', code: '42501', message: 'new row violates row-level security policy' },
    ])
  })

  // The row changed between the read and the write, or the update policy is missing (#73). Either
  // way nothing was written, and the editors reload on a 409 to show the latest.
  it('answers 409 when the write matched no rows, and logs it', async () => {
    makeSupabase({ update: { error: null, count: 0 } })
    const res = await mark()
    expect(res.status).toBe(409)
    expect(await errorOf(res)).toBe('This transaction just changed. Refresh and try again.')
    expect(logs).toContainEqual([
      '[reimbursable] update matched no rows (row changed, or the update policy is missing)',
      { id: 'txn-1' },
    ])
  })

  // A count the server did not send is not a count of one.
  it('answers 409 when the write returns no count', async () => {
    makeSupabase({ update: { error: null, count: null } })
    expect((await mark()).status).toBe(409)
  })
})
