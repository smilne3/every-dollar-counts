import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// POST /api/manual-assets: Settings → Home value (HomeValueCard), which moves net worth (#165). Its
// messages reach the person verbatim, so none may carry the database's words. The environment
// guard has its own file, tests/unit/manual-assets-env.test.ts.
//
// The stand-in is strict, as in tests/unit/budgets-route.test.ts (#99, #101): the membership read
// resolves only through .select().limit(1).maybeSingle() and projects the fixture to the columns it
// asks for, so .single() (which errors on no row) or a narrowed select cannot pass, and the upsert
// records exactly what it was given, and can go unanswered, as postgrest-js reports a request lost
// in flight (#173).
const { assertEnvMatchesDatabase } = vi.hoisted(() => ({ assertEnvMatchesDatabase: vi.fn() }))

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/plaid', () => ({ plaidEnv: 'sandbox' }))
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: {} }))
vi.mock('@/lib/app-env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/app-env')>()),
  assertEnvMatchesDatabase,
}))

import { AuthRetryableFetchError, type AuthError } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { POST } from '@/app/api/manual-assets/route'
import { NO_ANSWER } from '../stubs/no-answer'
import { answerOf, UNKNOWN_ANSWER } from './helpers/route-answers'

type Row = Record<string, unknown>
type DbError = { code?: string; message: string } | null

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
  upsertError = null as DbError,
  // The database never answers the upsert.
  noAnswer = false,
  // Called as the upsert is done, so a test can move the clock on.
  onWrite = () => {},
} = {}) {
  const calls = { membership: [] as unknown[][], upserts: [] as { row: Row; options: unknown }[] }
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
      if (table === 'manual_assets') {
        return {
          upsert: (row: Row, options: unknown) => {
            calls.upserts.push({ row, options })
            onWrite()
            return Promise.resolve(noAnswer ? NO_ANSWER : { error: upsertError })
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
    new Request('http://localhost/api/manual-assets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  )
const save = () => post({ value: 750000 })
const errorOf = async (res: Response) => (await res.json()).error

const TRY_AGAIN = 'That could not be saved. Please try again.'

let logs: unknown[][]
beforeEach(() => {
  vi.mocked(createClient).mockReset()
  assertEnvMatchesDatabase.mockReset().mockResolvedValue(undefined)
  logs = []
  vi.spyOn(console, 'error').mockImplementation((...a) => void logs.push(a))
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('POST /api/manual-assets: validation before the database', () => {
  it.each([
    ['malformed JSON', '{not json'],
    ['no value', {}],
    // NaN and Infinity have no JSON form and arrive as null.
    ['a value that is not finite', { value: null }],
    ['a value too large to be finite', '{"value":1e400}'],
    ['a negative value', { value: -1 }],
    ['a negative value written as currency', { value: '-$5,000' }],
    // Number('') is 0: read as a value, these would set the home to $0.
    ['an empty string', { value: '' }],
    ['a string with only currency marks', { value: ' $, ' }],
    ['a string that is not a number', { value: 'lots' }],
    ['a value that is neither a number nor a string', { value: [750000] }],
    ['a boolean', { value: true }],
  ])('answers 400 for %s, in words, without touching the database', async (_, body) => {
    const res = await post(body)
    expect(res.status).toBe(400)
    expect(await errorOf(res)).toBe('Enter your home value, e.g. 750000 or $750,000.')
    expect(createClient).not.toHaveBeenCalled()
  })
})

describe('POST /api/manual-assets', () => {
  it("upserts the household's Home at the value given, stamped with this environment", async () => {
    const calls = makeSupabase()
    const res = await save()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, savedAt: expect.any(Number) })
    expect(calls.membership).toEqual([['select', 'household_id'], ['limit', 1]])
    expect(calls.upserts).toHaveLength(1)
    const [{ row, options }] = calls.upserts
    expect(row).toEqual({ household_id: 'hh-1', name: 'Home', value: 750000, plaid_env: 'sandbox', updated_at: expect.any(String) })
    expect(Number.isNaN(Date.parse(row.updated_at as string))).toBe(false)
    expect(options).toEqual({ onConflict: 'household_id,name' })
  })

  // #174: HomeValueCard refills what it sent only from a page that read the value after the save, so
  // a time taken before the write would let a page read in between pass as newer.
  it('says when the value was written, by the server clock, once the upsert is done', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_000)
    makeSupabase({ onWrite: () => vi.setSystemTime(Date.now() + 1_000) })
    const res = await save()
    expect(await res.json()).toEqual({ ok: true, savedAt: 2_000 })
  })

  // What Zillow shows, verbatim; the card strips it too.
  it.each([
    ['a currency-formatted string', '$750,000', 750000],
    ['a string with spaces', ' 750 000 ', 750000],
    ['zero', 0, 0],
  ])('accepts %s', async (_, value, stored) => {
    const calls = makeSupabase()
    expect((await post({ value })).status).toBe(200)
    expect(calls.upserts[0].row.value).toBe(stored)
  })

  it('answers 401 without a user, in words, and writes nothing', async () => {
    const calls = makeSupabase({ user: null })
    const res = await save()
    expect(res.status).toBe(401)
    expect(await errorOf(res)).toBe('Your session ended. Sign in again.')
    expect(calls.upserts).toHaveLength(0)
  })

  // Supabase Auth unreachable is not a signed-out person: "sign in again" would not fix anything.
  it('answers 503 and logs when the auth check itself fails, and writes nothing', async () => {
    const authError = new AuthRetryableFetchError('fetch failed', 0)
    const calls = makeSupabase({ user: null, authError })
    const res = await save()
    expect(res.status).toBe(503)
    expect(await errorOf(res)).toBe(TRY_AGAIN)
    expect(logs).toContainEqual(['[manual-assets] auth check failed', { code: authError.code, message: 'fetch failed' }])
    expect(calls.upserts).toHaveLength(0)
  })

  // A failed read is not "no household" (#162).
  it('answers 500, not 403, when the membership read fails, logs it and writes nothing', async () => {
    const calls = makeSupabase({ membership: { data: null, error: { code: '57014', message: 'statement timeout' } } })
    const res = await save()
    expect(res.status).toBe(500)
    expect(await errorOf(res)).toBe(TRY_AGAIN)
    expect(logs).toContainEqual(['[manual-assets] membership read failed', { code: '57014', message: 'statement timeout' }])
    expect(calls.upserts).toHaveLength(0)
    expect(assertEnvMatchesDatabase).not.toHaveBeenCalled()
  })

  it('answers 403 in words when the account has no household, and writes nothing', async () => {
    const calls = makeSupabase({ membership: { data: null, error: null } })
    const res = await save()
    expect(res.status).toBe(403)
    expect(await errorOf(res)).toBe("Your account isn't part of a household.")
    expect(calls.upserts).toHaveLength(0)
  })

  it('answers 500 for a failed upsert, logs the database text and does not show it', async () => {
    makeSupabase({ upsertError: { code: '42501', message: 'new row violates row-level security policy' } })
    const res = await save()
    expect(res.status).toBe(500)
    expect(await errorOf(res)).toBe(TRY_AGAIN)
    expect(logs).toContainEqual([
      '[manual-assets] upsert failed',
      { household_id: 'hh-1', code: '42501', message: 'new row violates row-level security policy' },
    ])
  })

  // #173: the value may have been written, so the outcome is unknown, never a refusal.
  it('answers that it may not have saved when the database never answers the upsert, and logs it', async () => {
    makeSupabase({ noAnswer: true })
    const res = await save()
    expect(await answerOf(res)).toEqual(UNKNOWN_ANSWER)
    expect(logs).toContainEqual(['[manual-assets] upsert failed', { household_id: 'hh-1', code: '', message: 'TypeError: fetch failed' }])
  })
})
