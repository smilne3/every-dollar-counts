import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// POST /api/household/timezone: Settings → Time zone (TimezoneCard), the zone every date in the app
// is worked out in (#73, #165). Its messages reach the person verbatim, so none may carry the
// database's words.
//
// The stand-in is strict, as in tests/unit/reimbursable-route.test.ts (#99, #101). The old one
// returned a count whether or not one was asked for and ignored the update's filter, so dropping
// { count: 'exact' } or narrowing the update to the wrong row left it green. This one:
// - resolves the membership read only through .select().limit(1).maybeSingle(), projected to the
//   columns asked for;
// - records every filter on the update, which runs only when awaited after the whole chain, against
//   the households that match each filter's column and value;
// - returns a count only when { count: 'exact' } is asked for, as PostgREST does;
// - can leave the update unanswered, as postgrest-js reports a request lost in flight (#173).
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))

import { AuthRetryableFetchError, type AuthError } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { MAY_NOT_HAVE_SAVED } from '@/lib/save-response'
import { POST } from '@/app/api/household/timezone/route'
import { NO_ANSWER } from '../stubs/no-answer'

type Row = Record<string, unknown>
type DbError = { code?: string; message: string } | null

const HOUSEHOLDS: Row[] = [{ id: 'hh-1', name: 'The Milnes', timezone: 'America/New_York' }]

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
  // The households the update can reach. None: the update policy is missing, as before #73.
  households = HOUSEHOLDS,
  updateError = null as DbError,
  // The database never answers the update.
  noAnswer = false,
  // Called as the update is done, so a test can move the clock on.
  onWrite = () => {},
} = {}) {
  const calls = { membership: [] as unknown[][], updates: [] as { payload: Row; options: unknown; filters: unknown[][] }[] }
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
      if (table === 'households') {
        return {
          update: (payload: Row, options?: { count?: string }) => {
            const entry = { payload, options, filters: [] as unknown[][] }
            calls.updates.push(entry)
            // Like PostgREST's builder: each filter is recorded and returns the builder, and awaiting
            // it runs the write against the households every filter matches.
            const builder = {
              eq: (col: string, val: unknown) => (entry.filters.push(['eq', col, val]), builder),
              then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
                onWrite()
                if (noAnswer) return Promise.resolve(NO_ANSWER).then(resolve, reject)
                const matched = households.filter((h) => entry.filters.every(([, col, val]) => h[col as string] === val)).length
                const result = updateError ? { error: updateError, count: null } : { error: null, count: matched }
                return Promise.resolve(options?.count === 'exact' ? result : { ...result, count: null }).then(resolve, reject)
              },
            }
            return builder
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
    new Request('http://localhost/api/household/timezone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  )
const save = () => post({ timezone: 'America/Chicago' })
const errorOf = async (res: Response) => (await res.json()).error

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

describe('POST /api/household/timezone', () => {
  // Validated before the database is touched: Postgres cannot check an IANA name, so this is the
  // only place it can be checked at all.
  it.each([
    ['a zone Intl does not know', { timezone: 'Mars/Olympus_Mons' }],
    ['a missing timezone', {}],
    ['a timezone that is not a string', { timezone: 5 }],
    ['malformed JSON', '{not json'],
    // Parses, to null: destructured, it threw before any answer.
    ['a body of JSON null', 'null'],
  ])('answers 400 for %s, in words, without touching the database', async (_, body) => {
    const res = await post(body)
    expect(res.status).toBe(400)
    expect(await errorOf(res)).toBe('That is not a timezone we recognise.')
    expect(createClient).not.toHaveBeenCalled()
  })

  it("writes the trimmed zone to the caller's household, counted", async () => {
    const calls = makeSupabase()
    const res = await post({ timezone: ' America/Chicago ' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, savedAt: expect.any(Number) })
    expect(calls.membership).toEqual([['select', 'household_id'], ['limit', 1]])
    expect(calls.updates).toEqual([
      { payload: { timezone: 'America/Chicago' }, options: { count: 'exact' }, filters: [['eq', 'id', 'hh-1']] },
    ])
  })

  // #182: TimezoneCard follows the server only from a page that read the zone after the save, so a
  // time taken before the write would let a page read in between pass as newer.
  it('says when the zone was written, by the server clock, once the update is done', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_000)
    makeSupabase({ onWrite: () => vi.setSystemTime(Date.now() + 1_000) })
    const res = await save()
    expect(await res.json()).toEqual({ ok: true, savedAt: 2_000 })
  })

  it('answers 401 without a user, in words, and writes nothing', async () => {
    const calls = makeSupabase({ user: null })
    const res = await save()
    expect(res.status).toBe(401)
    expect(await errorOf(res)).toBe('Your session ended. Sign in again.')
    expect(calls.updates).toHaveLength(0)
  })

  // Supabase Auth unreachable is not a signed-out person: "sign in again" would not fix anything.
  it('answers 503 and logs when the auth check itself fails, and writes nothing', async () => {
    const authError = new AuthRetryableFetchError('fetch failed', 0)
    const calls = makeSupabase({ user: null, authError })
    const res = await save()
    expect(res.status).toBe(503)
    expect(await errorOf(res)).toBe(TRY_AGAIN)
    expect(logs).toContainEqual(['[household/timezone] auth check failed', { code: authError.code, message: 'fetch failed' }])
    expect(calls.updates).toHaveLength(0)
  })

  // A failed read is not "no household" (#162).
  it('answers 500, not 403, when the membership read fails, logs it and writes nothing', async () => {
    const calls = makeSupabase({ membership: { data: null, error: { code: '57014', message: 'statement timeout' } } })
    const res = await save()
    expect(res.status).toBe(500)
    expect(await errorOf(res)).toBe(TRY_AGAIN)
    expect(logs).toContainEqual(['[household/timezone] membership read failed', { code: '57014', message: 'statement timeout' }])
    expect(calls.updates).toHaveLength(0)
  })

  it('answers 403 in words when the account has no household, and writes nothing', async () => {
    const calls = makeSupabase({ membership: { data: null, error: null } })
    const res = await save()
    expect(res.status).toBe(403)
    expect(await errorOf(res)).toBe("Your account isn't part of a household.")
    expect(calls.updates).toHaveLength(0)
  })

  // households had no update policy before #73's migration. If it is ever missing again, the
  // update matches zero rows and Supabase reports SUCCESS — so a silent no-op has to be caught
  // here rather than shown to the user as a save that worked.
  it('reports a write that changed nothing rather than claiming success, and logs it', async () => {
    makeSupabase({ households: [] })
    const res = await save()
    expect(res.status).toBe(500)
    expect(await errorOf(res)).toBe(TRY_AGAIN)
    expect(logs).toContainEqual(['[household/timezone] update matched no rows — is the update policy present?', { household_id: 'hh-1' }])
  })

  it("reports a failed write, logs the database's words and does not show them", async () => {
    makeSupabase({ updateError: { code: '42501', message: 'permission denied for table households' } })
    const res = await save()
    expect(res.status).toBe(500)
    expect(await errorOf(res)).toBe(TRY_AGAIN)
    expect(logs).toContainEqual([
      '[household/timezone] update failed',
      { household_id: 'hh-1', code: '42501', message: 'permission denied for table households' },
    ])
  })

  // #173: the zone may have been written, so the outcome is unknown, never a refusal.
  it('answers that it may not have saved when the database never answers the update, and logs it', async () => {
    makeSupabase({ noAnswer: true })
    const res = await save()
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: MAY_NOT_HAVE_SAVED, unknown: true })
    expect(logs).toContainEqual(['[household/timezone] update failed', { household_id: 'hh-1', code: '', message: 'TypeError: fetch failed' }])
  })
})
