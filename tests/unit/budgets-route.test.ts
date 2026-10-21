import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// POST /api/budgets: Budgets → Save budgets, one bulk save (#162). A limit above zero is upserted
// for the caller's household; a limit set to 0 or left blank is deleted. Its messages reach the
// person verbatim (BudgetEditor), so none may carry the database's words.
//
// The stand-in is strict, as in tests/unit/categorize-route.test.ts (#99, #101):
// - the membership read only resolves through .limit(1).maybeSingle(), so .single(), which errors
//   on no row and would turn "no household" into a failed read, cannot pass;
// - the delete is not thenable until it is narrowed to the household and then to the categories
//   being cleared, so a delete missing either filter cannot produce a result;
// - either write can go unanswered, as postgrest-js reports a request lost in flight (#173).
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))

import { AuthRetryableFetchError, type AuthError } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { POST } from '@/app/api/budgets/route'
import { NO_ANSWER, REFUSED_5XX } from '../stubs/no-answer'
import { answerOf, UNKNOWN_ANSWER } from './helpers/route-answers'

type Row = Record<string, unknown>
type DbError = { code?: string; message: string } | null

function makeSupabase({
  user = { id: 'user-1' } as { id: string } | null,
  authError = null as AuthError | null,
  membership = { data: { household_id: 'hh-1' } as Row | null, error: null as DbError },
  upsertError = null as DbError,
  deleteError = null as DbError,
  // A reply for a write in place of its usual one.
  replies = {} as Partial<Record<'upsert' | 'delete', unknown>>,
  // Called as each write is done, so a test can move the clock on.
  onWrite = () => {},
} = {}) {
  const calls = {
    membership: [] as unknown[][],
    upserts: [] as { rows: Row[]; options: unknown }[],
    deletes: [] as { filters: unknown[][] }[],
  }
  const client = {
    // getUser answers { user: null, error } on ANY auth failure, a dropped connection included.
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user }, error: authError }) },
    from: vi.fn((table: string) => {
      if (table === 'memberships') {
        return {
          select: (cols: string) => {
            calls.membership.push(['select', cols])
            return {
              limit: (n: number) => {
                calls.membership.push(['limit', n])
                return { maybeSingle: () => Promise.resolve(membership) }
              },
            }
          },
        }
      }
      if (table === 'budgets') {
        return {
          upsert: (rows: Row[], options: unknown) => {
            calls.upserts.push({ rows, options })
            onWrite()
            return Promise.resolve(replies.upsert ?? { error: upsertError })
          },
          delete: () => {
            const entry = { filters: [] as unknown[][] }
            calls.deletes.push(entry)
            return {
              eq: (col: string, val: unknown) => {
                entry.filters.push(['eq', col, val])
                return {
                  in: (col2: string, vals: unknown[]) => {
                    entry.filters.push(['in', col2, vals])
                    onWrite()
                    return Promise.resolve(replies.delete ?? { error: deleteError })
                  },
                }
              },
            }
          },
        }
      }
      throw new Error(`unexpected table ${table}`)
    }),
  }
  vi.mocked(createClient).mockResolvedValue(client as never)
  return calls
}

const post = (body: unknown) =>
  POST(
    new Request('http://localhost/api/budgets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  )
// What BudgetEditor sends: every spending category, a blank or 0 limit as 0.
const ITEMS = [
  { category: 'Groceries', monthly_limit: 400 },
  { category: 'Dining', monthly_limit: 0 },
  { category: 'Travel', monthly_limit: 150.5 },
]
const save = () => post({ items: ITEMS })
const errorOf = async (res: Response) => (await res.json()).error
const writes = (calls: ReturnType<typeof makeSupabase>) => calls.upserts.length + calls.deletes.length

const TRY_AGAIN = 'That could not be saved. Please try again.'

let logs: unknown[][]
beforeEach(() => {
  vi.mocked(createClient).mockReset()
  logs = []
  vi.spyOn(console, 'error').mockImplementation((...a) => void logs.push(a))
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('POST /api/budgets: validation before the database', () => {
  it.each([
    ['malformed JSON', '{not json'],
    ['no items', {}],
    ['items that are not a list', { items: { category: 'Groceries', monthly_limit: 400 } }],
    ['an item with no category', { items: [{ monthly_limit: 400 }] }],
    // NaN and Infinity have no JSON form and arrive as null, which Number() would read as 0: a clear.
    ['a limit that is not a finite number', { items: [{ category: 'Groceries', monthly_limit: null }] }],
    ['a limit that is not a number at all', { items: [{ category: 'Groceries', monthly_limit: 'lots' }] }],
    // A number too big for a double parses to Infinity.
    ['a limit too large to be finite', '{"items":[{"category":"Groceries","monthly_limit":1e400}]}'],
  ])('answers 400 for %s, in words, without touching the database', async (_, body) => {
    const res = await post(body)
    expect(res.status).toBe(400)
    expect(await errorOf(res)).toBe('That could not be saved. Refresh and try again.')
    expect(createClient).not.toHaveBeenCalled()
  })
})

// Number('-50') > 0 is false, so a negative limit used to be read as "no limit": the old one was
// deleted and the editor said "Saved.".
it('answers 400 for a negative limit, in words, and writes nothing', async () => {
  const calls = makeSupabase()
  const res = await post({ items: [{ category: 'Groceries', monthly_limit: -50 }, { category: 'Dining', monthly_limit: 0 }] })
  expect(res.status).toBe(400)
  expect(await errorOf(res)).toBe("Limits can't be negative.")
  expect(writes(calls)).toBe(0)
})

describe('POST /api/budgets', () => {
  it('answers 401 without a user, in words, and writes nothing', async () => {
    const calls = makeSupabase({ user: null })
    const res = await save()
    expect(res.status).toBe(401)
    expect(await errorOf(res)).toBe('Your session ended. Sign in again.')
    expect(writes(calls)).toBe(0)
  })

  // Supabase Auth unreachable is not a signed-out person: "sign in again" would not fix anything.
  it('answers 503 and logs when the auth check itself fails, and writes nothing', async () => {
    const authError = new AuthRetryableFetchError('fetch failed', 0)
    const calls = makeSupabase({ user: null, authError })
    const res = await save()
    expect(res.status).toBe(503)
    expect(await errorOf(res)).toBe(TRY_AGAIN)
    expect(logs).toContainEqual(['[budgets] auth check failed', { code: authError.code, message: 'fetch failed' }])
    expect(writes(calls)).toBe(0)
  })

  // #162: a failed membership read used to answer 403 "no household", as if the account had none.
  it('answers 500, not 403, when the membership read fails, logs it and writes nothing', async () => {
    const calls = makeSupabase({ membership: { data: null, error: { code: '57014', message: 'statement timeout' } } })
    const res = await save()
    expect(res.status).toBe(500)
    expect(await errorOf(res)).toBe(TRY_AGAIN)
    expect(logs).toContainEqual(['[budgets] membership read failed', { code: '57014', message: 'statement timeout' }])
    expect(writes(calls)).toBe(0)
  })

  it('answers 403 in words when the account has no household, and writes nothing', async () => {
    const calls = makeSupabase({ membership: { data: null, error: null } })
    const res = await save()
    expect(res.status).toBe(403)
    expect(await errorOf(res)).toBe("Your account isn't part of a household.")
    expect(writes(calls)).toBe(0)
  })

  it("upserts the limits above zero for the caller's household and deletes the rest from it", async () => {
    const calls = makeSupabase()
    const res = await save()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, savedAt: expect.any(Number) })
    expect(calls.membership).toEqual([['select', 'household_id'], ['limit', 1]])
    expect(calls.upserts).toEqual([
      {
        rows: [
          { household_id: 'hh-1', category: 'Groceries', monthly_limit: 400 },
          { household_id: 'hh-1', category: 'Travel', monthly_limit: 150.5 },
        ],
        options: { onConflict: 'household_id,category' },
      },
    ])
    expect(calls.deletes).toEqual([{ filters: [['eq', 'household_id', 'hh-1'], ['in', 'category', ['Dining']]] }])
  })

  // #176: BudgetEditor refills what it sent only from a page that read the limits after the save,
  // so a time taken before either write would let a page read in between pass as newer.
  it('says when the save was written, by the server clock, once both writes are done', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_000)
    makeSupabase({ onWrite: () => vi.setSystemTime(Date.now() + 1_000) })
    const res = await save()
    expect(await res.json()).toEqual({ ok: true, savedAt: 3_000 })
  })

  it('answers 500 for a failed upsert, logs the database text, does not show it, and deletes nothing', async () => {
    const calls = makeSupabase({ upsertError: { code: '42501', message: 'new row violates row-level security policy' } })
    const res = await save()
    expect(res.status).toBe(500)
    expect(await errorOf(res)).toBe(TRY_AGAIN)
    expect(logs).toContainEqual([
      '[budgets] upsert failed',
      { household_id: 'hh-1', code: '42501', message: 'new row violates row-level security policy' },
    ])
    expect(calls.deletes).toHaveLength(0)
  })

  // #162: the delete's error was ignored, so a limit set to 0 stayed and the editor said "Saved.".
  // The upsert ran first, so this says what did not save rather than that nothing did.
  it('answers 500 when clearing limits fails, says which part did not save, and logs it', async () => {
    makeSupabase({ deleteError: { code: '42501', message: 'permission denied for table budgets' } })
    const res = await save()
    expect(res.status).toBe(500)
    expect(await errorOf(res)).toBe('The limits you cleared could not be removed. Please try again.')
    expect(logs).toContainEqual([
      '[budgets] delete failed',
      { household_id: 'hh-1', code: '42501', message: 'permission denied for table budgets' },
    ])
  })

  // #173: either write the database never answered may have landed, so the save's outcome is
  // unknown, never a refusal. After an upsert with no answer, the delete does not run.
  it('answers that it may not have saved when the database never answers the upsert, logs it and deletes nothing', async () => {
    const calls = makeSupabase({ replies: { upsert: NO_ANSWER } })
    const res = await save()
    expect(await answerOf(res)).toEqual(UNKNOWN_ANSWER)
    expect(logs).toContainEqual(['[budgets] upsert failed', { household_id: 'hh-1', code: '', message: 'TypeError: fetch failed' }])
    expect(calls.deletes).toHaveLength(0)
  })

  it('answers that it may not have saved when the database never answers the delete', async () => {
    makeSupabase({ replies: { delete: NO_ANSWER } })
    const res = await save()
    expect(await answerOf(res)).toEqual(UNKNOWN_ANSWER)
  })

  // A refusal carries a code, 5xx or not, and is answered as before.
  it('answers 500 for a refused upsert whose status is a 5xx, since it carries a code, and deletes nothing', async () => {
    const calls = makeSupabase({ replies: { upsert: REFUSED_5XX } })
    const res = await save()
    expect(res.status).toBe(500)
    expect(await errorOf(res)).toBe(TRY_AGAIN)
    expect(calls.deletes).toHaveLength(0)
  })

  it('answers 500 for a refused delete whose status is a 5xx, and says which part did not save', async () => {
    makeSupabase({ replies: { delete: REFUSED_5XX } })
    const res = await save()
    expect(res.status).toBe(500)
    expect(await errorOf(res)).toBe('The limits you cleared could not be removed. Please try again.')
  })
})
