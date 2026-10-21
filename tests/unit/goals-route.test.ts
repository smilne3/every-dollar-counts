import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// /api/goals: GoalsList's add (POST), update of the amount saved (PATCH) and delete (DELETE) (#165).
// Its messages reach the person verbatim, so none may carry the database's words.
//
// The stand-in is strict, as in tests/unit/reimbursable-route.test.ts (#99, #101):
// - the membership read resolves only through .select().limit(1).maybeSingle(), and projects the
//   fixture to the columns it asks for, so .single() (which errors on no row) or a narrowed select
//   cannot pass;
// - an update or delete records every filter and runs only when awaited after the whole chain,
//   against the goals that match each filter's column and value;
// - a write returns a count only when { count: 'exact' } is asked for, as PostgREST does.
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))

import { AuthRetryableFetchError, type AuthError } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { POST, PATCH, DELETE } from '@/app/api/goals/route'

type Row = Record<string, unknown>
type DbError = { code?: string; message: string } | null
type Write = { op: 'update' | 'delete'; payload?: Row; options: unknown; filters: unknown[][] }

const GOALS: Row[] = [
  { id: 'g-1', household_id: 'hh-1', name: 'Emergency fund', target_amount: 3000, saved_amount: 1200 },
  { id: 'g-2', household_id: 'hh-1', name: 'New roof', target_amount: 9000, saved_amount: 500 },
]

function project(data: Row | null, columns: string): Row | null {
  if (!data) return data
  const out: Row = {}
  for (const c of columns.split(',').map((s) => s.trim())) if (c in data) out[c] = data[c]
  return out
}

function makeSupabase({
  user = { id: 'user-1' } as { id: string } | null,
  authError = null as AuthError | null,
  membership = { data: { household_id: 'hh-1' } as Row | null, error: null as DbError },
  insertError = null as DbError,
  writeError = null as DbError,
  // Called as an update or delete is done, so a test can move the clock on.
  onWrite = () => {},
} = {}) {
  const calls = { membership: [] as unknown[][], inserts: [] as Row[], writes: [] as Write[] }
  // Like PostgREST's builder: each filter is recorded and returns the builder, and awaiting it runs
  // the write against the goals every filter matches.
  const write = (entry: Write) => {
    calls.writes.push(entry)
    const builder = {
      eq: (col: string, val: unknown) => (entry.filters.push(['eq', col, val]), builder),
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
        onWrite()
        const matched = GOALS.filter((g) => entry.filters.every(([, col, val]) => g[col as string] === val)).length
        const result = writeError ? { error: writeError, count: null } : { error: null, count: matched }
        const counted = (entry.options as { count?: string } | undefined)?.count === 'exact'
        return Promise.resolve(counted ? result : { ...result, count: null }).then(resolve, reject)
      },
    }
    return builder
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
                return { maybeSingle: () => Promise.resolve({ ...membership, data: project(membership.data, cols) }) }
              },
            }
          },
        }
      }
      if (table === 'goals') {
        return {
          insert: (row: Row) => {
            calls.inserts.push(row)
            return Promise.resolve({ error: insertError })
          },
          update: (payload: Row, options?: unknown) => write({ op: 'update', payload, options, filters: [] }),
          delete: (options?: unknown) => write({ op: 'delete', options, filters: [] }),
        }
      }
      throw new Error(`unexpected table ${table}`)
    }),
  }
  vi.mocked(createClient).mockResolvedValue(client as never)
  return calls
}

const send = (handler: (req: Request) => Promise<Response>, method: string, body: unknown) =>
  handler(
    new Request('http://localhost/api/goals', {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  )
const add = (body: unknown = { name: '  Emergency fund ', target_amount: 3000 }) => send(POST, 'POST', body)
const update = (body: unknown = { id: 'g-1', saved_amount: 1500 }) => send(PATCH, 'PATCH', body)
const remove = (body: unknown = { id: 'g-1' }) => send(DELETE, 'DELETE', body)
const errorOf = async (res: Response) => (await res.json()).error
const writes = (calls: ReturnType<typeof makeSupabase>) => calls.inserts.length + calls.writes.length

const TRY_AGAIN = 'That could not be saved. Please try again.'
const GONE = 'That goal no longer exists.'

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

// The three handlers sign in the same way, and each must refuse before writing.
describe.each([
  ['POST', () => add()],
  ['PATCH', () => update()],
  ['DELETE', () => remove()],
])('%s /api/goals: sign-in', (_, call) => {
  it('answers 401 without a user, in words, and writes nothing', async () => {
    const calls = makeSupabase({ user: null })
    const res = await call()
    expect(res.status).toBe(401)
    expect(await errorOf(res)).toBe('Your session ended. Sign in again.')
    expect(writes(calls)).toBe(0)
  })

  // Supabase Auth unreachable is not a signed-out person: "sign in again" would not fix anything.
  it('answers 503 and logs when the auth check itself fails, and writes nothing', async () => {
    const authError = new AuthRetryableFetchError('fetch failed', 0)
    const calls = makeSupabase({ user: null, authError })
    const res = await call()
    expect(res.status).toBe(503)
    expect(await errorOf(res)).toBe(TRY_AGAIN)
    expect(logs).toContainEqual(['[goals] auth check failed', { code: authError.code, message: 'fetch failed' }])
    expect(writes(calls)).toBe(0)
  })
})

describe('POST /api/goals', () => {
  it.each([
    ['malformed JSON', '{not json'],
    ['no name', { target_amount: 3000 }],
    ['a blank name', { name: '   ', target_amount: 3000 }],
    ['a name that is not a string', { name: 7, target_amount: 3000 }],
    ['no target', { name: 'Emergency fund' }],
    ['a target of zero', { name: 'Emergency fund', target_amount: 0 }],
    ['a negative target', { name: 'Emergency fund', target_amount: -5 }],
    ['a target that is not a number', { name: 'Emergency fund', target_amount: '3000' }],
    // NaN and Infinity have no JSON form and arrive as null.
    ['a target that is not finite', { name: 'Emergency fund', target_amount: null }],
    // A number too big for a double parses to Infinity.
    ['a target too large to be finite', '{"name":"Emergency fund","target_amount":1e400}'],
  ])('answers 400 for %s, in words, without touching the database', async (_, body) => {
    const res = await add(body)
    expect(res.status).toBe(400)
    expect(await errorOf(res)).toBe('Give the goal a name and a target above zero.')
    expect(createClient).not.toHaveBeenCalled()
  })

  it("adds the trimmed goal, with nothing saved yet, to the caller's household", async () => {
    const calls = makeSupabase()
    const res = await add()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(calls.membership).toEqual([['select', 'household_id'], ['limit', 1]])
    expect(calls.inserts).toEqual([{ household_id: 'hh-1', name: 'Emergency fund', target_amount: 3000, saved_amount: 0 }])
  })

  // A failed read is not "no household" (#162).
  it('answers 500, not 403, when the membership read fails, logs it and writes nothing', async () => {
    const calls = makeSupabase({ membership: { data: null, error: { code: '57014', message: 'statement timeout' } } })
    const res = await add()
    expect(res.status).toBe(500)
    expect(await errorOf(res)).toBe(TRY_AGAIN)
    expect(logs).toContainEqual(['[goals] membership read failed', { code: '57014', message: 'statement timeout' }])
    expect(writes(calls)).toBe(0)
  })

  it('answers 403 in words when the account has no household, and writes nothing', async () => {
    const calls = makeSupabase({ membership: { data: null, error: null } })
    const res = await add()
    expect(res.status).toBe(403)
    expect(await errorOf(res)).toBe("Your account isn't part of a household.")
    expect(writes(calls)).toBe(0)
  })

  it('answers 500 for a failed insert, logs the database text and does not show it', async () => {
    makeSupabase({ insertError: { code: '42501', message: 'new row violates row-level security policy' } })
    const res = await add()
    expect(res.status).toBe(500)
    expect(await errorOf(res)).toBe(TRY_AGAIN)
    expect(logs).toContainEqual([
      '[goals] add failed',
      { household_id: 'hh-1', code: '42501', message: 'new row violates row-level security policy' },
    ])
  })
})

describe('PATCH /api/goals', () => {
  const REFRESH = 'That could not be saved. Refresh and try again.'
  it.each([
    ['malformed JSON', '{not json', REFRESH],
    ['no id', { saved_amount: 1500 }, REFRESH],
    ['an id that is not a string', { id: 7, saved_amount: 1500 }, REFRESH],
    ['nothing to update', { id: 'g-1' }, REFRESH],
    ['an amount saved that is not a number', { id: 'g-1', saved_amount: '1500' }, REFRESH],
    // NaN and Infinity have no JSON form and arrive as null, which Number() would read as 0.
    ['an amount saved that is not finite', { id: 'g-1', saved_amount: null }, REFRESH],
    ['an amount saved too large to be finite', '{"id":"g-1","saved_amount":1e400}', REFRESH],
    // It used to be stored as 0.
    ['a negative amount saved', { id: 'g-1', saved_amount: -50 }, "The amount saved can't be negative."],
    // A field that is sent must be valid: dropped, the rest would save and the reply say "saved".
    ['a blank name beside a valid amount', { id: 'g-1', saved_amount: 1500, name: '  ' }, REFRESH],
    ['a target of zero beside a valid amount', { id: 'g-1', saved_amount: 1500, target_amount: 0 }, REFRESH],
    ['a target that is not a number', { id: 'g-1', target_amount: '9000' }, REFRESH],
  ])('answers 400 for %s, in words, without touching the database', async (_, body, message) => {
    const res = await update(body)
    expect(res.status).toBe(400)
    expect(await errorOf(res)).toBe(message)
    expect(createClient).not.toHaveBeenCalled()
  })

  it('updates the amount saved on that goal alone, counted', async () => {
    const calls = makeSupabase()
    const res = await update()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, savedAt: expect.any(Number) })
    expect(calls.writes).toEqual([
      { op: 'update', payload: { saved_amount: 1500 }, options: { count: 'exact' }, filters: [['eq', 'id', 'g-1']] },
    ])
  })

  // #182: a goal's card refills what it sent only from a page that read the goals after the update,
  // so a time taken before the write would let a page read in between pass as newer.
  it('says when the update was written, by the server clock, once it is done', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_000)
    makeSupabase({ onWrite: () => vi.setSystemTime(Date.now() + 1_000) })
    const res = await update()
    expect(await res.json()).toEqual({ ok: true, savedAt: 2_000 })
  })

  it('saves an amount of zero', async () => {
    const calls = makeSupabase()
    expect((await update({ id: 'g-1', saved_amount: 0 })).status).toBe(200)
    expect(calls.writes[0].payload).toEqual({ saved_amount: 0 })
  })

  it('updates a trimmed name and a target', async () => {
    const calls = makeSupabase()
    expect((await update({ id: 'g-2', name: '  Roof ', target_amount: 9500 })).status).toBe(200)
    expect(calls.writes[0].payload).toEqual({ name: 'Roof', target_amount: 9500 })
    expect(calls.writes[0].filters).toEqual([['eq', 'id', 'g-2']])
  })

  // Deleted on the other phone, or never this household's: nothing was written, and GoalsList
  // reloads on a 404 to show the latest.
  it('answers 404 in words, and logs it, when the update matched no goal', async () => {
    makeSupabase()
    const res = await update({ id: 'g-gone', saved_amount: 1500 })
    expect(res.status).toBe(404)
    expect(await errorOf(res)).toBe(GONE)
    expect(logs).toContainEqual([
      '[goals] update matched no rows (goal deleted, or the update policy is missing)',
      { id: 'g-gone' },
    ])
  })

  it('answers 500 for a failed update, logs the database text and does not show it', async () => {
    makeSupabase({ writeError: { code: '42501', message: 'permission denied for table goals' } })
    const res = await update()
    expect(res.status).toBe(500)
    expect(await errorOf(res)).toBe(TRY_AGAIN)
    expect(logs).toContainEqual(['[goals] update failed', { id: 'g-1', code: '42501', message: 'permission denied for table goals' }])
  })
})

describe('DELETE /api/goals', () => {
  it.each([
    ['malformed JSON', '{not json'],
    ['no id', {}],
    ['an id that is not a string', { id: 7 }],
  ])('answers 400 for %s, in words, without touching the database', async (_, body) => {
    const res = await remove(body)
    expect(res.status).toBe(400)
    expect(await errorOf(res)).toBe('That goal could not be deleted. Refresh and try again.')
    expect(createClient).not.toHaveBeenCalled()
  })

  it('deletes that goal alone, counted', async () => {
    const calls = makeSupabase()
    const res = await remove()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(calls.writes).toEqual([{ op: 'delete', options: { count: 'exact' }, filters: [['eq', 'id', 'g-1']] }])
  })

  // Most likely deleted on the other phone: what was asked for is done, so the words say so rather
  // than "try again".
  it('answers 404 in words, and logs it, when the delete matched no goal', async () => {
    makeSupabase()
    const res = await remove({ id: 'g-gone' })
    expect(res.status).toBe(404)
    expect(await errorOf(res)).toBe('That goal was already deleted.')
    expect(logs).toContainEqual([
      '[goals] delete matched no rows (goal already deleted, or the delete policy is missing)',
      { id: 'g-gone' },
    ])
  })

  it('answers 500 for a failed delete, logs the database text and does not show it', async () => {
    makeSupabase({ writeError: { code: '42501', message: 'permission denied for table goals' } })
    const res = await remove()
    expect(res.status).toBe(500)
    expect(await errorOf(res)).toBe('That goal could not be deleted. Please try again.')
    expect(logs).toContainEqual(['[goals] delete failed', { id: 'g-1', code: '42501', message: 'permission denied for table goals' }])
  })
})
