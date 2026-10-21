import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// POST /api/household/invite: Settings → Invite your partner (InvitePartnerForm), which writes an
// email to the household's allowlist (#165). Its messages reach the person verbatim, so none may
// carry the database's words.
//
// The stand-in is strict, as in tests/unit/reimbursable-route.test.ts (#99, #101). The membership
// read resolves only through .select().eq().limit(1).maybeSingle(), against membership rows the way
// RLS and the filter would match them (the caller's own rows, on the column and value given),
// projected to the columns asked for. The upsert records exactly what it was given, and can go
// unanswered, as postgrest-js reports a request lost in flight (#173).
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))

import { AuthRetryableFetchError, type AuthError } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { POST } from '@/app/api/household/invite/route'
import { NO_ANSWER } from '../stubs/no-answer'
import { answerOf, UNKNOWN_ANSWER } from './helpers/route-answers'

type Row = Record<string, unknown>
type DbError = { code?: string; message: string } | null

// The caller's membership, and another household's that RLS hides from the caller.
const MEMBERSHIPS: Row[] = [
  { user_id: 'user-1', household_id: 'hh-1' },
  { user_id: 'user-9', household_id: 'hh-9' },
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
  membershipError = null as DbError,
  upsertError = null as DbError,
  // The database never answers the upsert.
  noAnswer = false,
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
              eq: (col: string, val: unknown) => {
                calls.membership.push(['eq', col, val])
                return {
                  limit: (n: number) => {
                    calls.membership.push(['limit', n])
                    return {
                      maybeSingle: () => {
                        if (membershipError) return Promise.resolve({ data: null, error: membershipError })
                        const row = MEMBERSHIPS.find((r) => r.user_id === user?.id && r[col] === val) ?? null
                        return Promise.resolve({ data: project(row, cols), error: null })
                      },
                    }
                  },
                }
              },
            }
          },
        }
      }
      if (table === 'invites') {
        return {
          upsert: (row: Row, options: unknown) => {
            calls.upserts.push({ row, options })
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
    new Request('http://localhost/api/household/invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  )
const invite = (over: Record<string, unknown> = {}) => post({ email: 'partner@example.com', household_id: 'hh-1', ...over })
const errorOf = async (res: Response) => (await res.json()).error

const TRY_AGAIN = 'That could not be saved. Please try again.'

let logs: unknown[][]
beforeEach(() => {
  vi.mocked(createClient).mockReset()
  logs = []
  vi.spyOn(console, 'error').mockImplementation((...a) => void logs.push(a))
})
afterEach(() => vi.restoreAllMocks())

describe('POST /api/household/invite: validation before the database', () => {
  it.each([
    ['malformed JSON', '{not json', "Enter your partner's email address."],
    ['no email', { household_id: 'hh-1' }, "Enter your partner's email address."],
    ['a blank email', { email: '   ', household_id: 'hh-1' }, "Enter your partner's email address."],
    ['an email that is not a string', { email: 7, household_id: 'hh-1' }, "Enter your partner's email address."],
    ['no household', { email: 'partner@example.com' }, 'That could not be saved. Refresh and try again.'],
    ['a household that is not a string', { email: 'partner@example.com', household_id: 1 }, 'That could not be saved. Refresh and try again.'],
  ])('answers 400 for %s, in words, without touching the database', async (_, body, message) => {
    const res = await post(body)
    expect(res.status).toBe(400)
    expect(await errorOf(res)).toBe(message)
    expect(createClient).not.toHaveBeenCalled()
  })
})

describe('POST /api/household/invite', () => {
  it('adds the trimmed, lower-cased email to the household it was given, once the caller is a member', async () => {
    const calls = makeSupabase()
    const res = await invite({ email: '  Partner@Example.com ' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(calls.membership).toEqual([['select', 'household_id'], ['eq', 'household_id', 'hh-1'], ['limit', 1]])
    expect(calls.upserts).toEqual([{ row: { email: 'partner@example.com', household_id: 'hh-1' }, options: { onConflict: 'email' } }])
  })

  it("answers 403 in words for a household the caller isn't in, and writes nothing", async () => {
    const calls = makeSupabase()
    const res = await invite({ household_id: 'hh-9' })
    expect(res.status).toBe(403)
    expect(await errorOf(res)).toBe("Your account isn't part of this household.")
    expect(calls.upserts).toHaveLength(0)
  })

  it('answers 401 without a user, in words, and writes nothing', async () => {
    const calls = makeSupabase({ user: null })
    const res = await invite()
    expect(res.status).toBe(401)
    expect(await errorOf(res)).toBe('Your session ended. Sign in again.')
    expect(calls.upserts).toHaveLength(0)
  })

  // Supabase Auth unreachable is not a signed-out person: "sign in again" would not fix anything.
  it('answers 503 and logs when the auth check itself fails, and writes nothing', async () => {
    const authError = new AuthRetryableFetchError('fetch failed', 0)
    const calls = makeSupabase({ user: null, authError })
    const res = await invite()
    expect(res.status).toBe(503)
    expect(await errorOf(res)).toBe(TRY_AGAIN)
    expect(logs).toContainEqual(['[household/invite] auth check failed', { code: authError.code, message: 'fetch failed' }])
    expect(calls.upserts).toHaveLength(0)
  })

  // A failed read is not "not your household" (#162): it answered 403 "forbidden".
  it('answers 500, not 403, when the membership read fails, logs it and writes nothing', async () => {
    const calls = makeSupabase({ membershipError: { code: '57014', message: 'statement timeout' } })
    const res = await invite()
    expect(res.status).toBe(500)
    expect(await errorOf(res)).toBe(TRY_AGAIN)
    expect(logs).toContainEqual(['[household/invite] membership read failed', { household_id: 'hh-1', code: '57014', message: 'statement timeout' }])
    expect(calls.upserts).toHaveLength(0)
  })

  it('answers 500 for a failed upsert, logs the database text and does not show it', async () => {
    makeSupabase({ upsertError: { code: '42501', message: 'new row violates row-level security policy for table "invites"' } })
    const res = await invite()
    expect(res.status).toBe(500)
    expect(await errorOf(res)).toBe(TRY_AGAIN)
    expect(logs).toContainEqual([
      '[household/invite] upsert failed',
      { household_id: 'hh-1', code: '42501', message: 'new row violates row-level security policy for table "invites"' },
    ])
  })

  // #173: the email may have been added, so the outcome is unknown, never a refusal.
  it('answers that it may not have saved when the database never answers the upsert, and logs it', async () => {
    makeSupabase({ noAnswer: true })
    const res = await invite()
    expect(await answerOf(res)).toEqual(UNKNOWN_ANSWER)
    expect(logs).toContainEqual(['[household/invite] upsert failed', { household_id: 'hh-1', code: '', message: 'TypeError: fetch failed' }])
  })
})
