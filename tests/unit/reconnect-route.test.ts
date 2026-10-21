import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// POST /api/plaid/reconnect: the end of Reconnect (ReconnectButton, and the OAuth return page). Link's
// update mode has fixed the login at Plaid by now; this route clears the broken flag and pulls what
// was missed. Its words are shown as they stand, and none may carry the database's.
//
// The stand-ins are strict, as in tests/unit/reimbursable-route.test.ts (#101): the membership read
// resolves only through .limit(1).maybeSingle(); the bank read only through .eq().maybeSingle(),
// matching on the value given and returning only the columns asked for; and the status write only
// once narrowed, recording how. The status write can get a reply of the test's: a request lost in
// flight, as postgrest-js reports it, or a 5xx refusal (#173).
const { createClient, adminFrom, decrypt, storeAccounts, syncAndStore, assertEnvMatchesDatabase } = vi.hoisted(() => ({
  createClient: vi.fn(),
  adminFrom: vi.fn(),
  decrypt: vi.fn(),
  storeAccounts: vi.fn(),
  syncAndStore: vi.fn(),
  assertEnvMatchesDatabase: vi.fn(),
}))
vi.mock('@/lib/supabase/server', () => ({ createClient }))
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: { from: adminFrom } }))
vi.mock('@/lib/plaid', () => ({ plaidEnv: 'sandbox' }))
vi.mock('@/lib/crypto', () => ({ decrypt }))
vi.mock('@/lib/ingest', () => ({ storeAccounts, syncAndStore }))
// The real envGuardResponse and EnvMismatchError; only the check itself is driven.
vi.mock('@/lib/app-env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/app-env')>()),
  assertEnvMatchesDatabase,
}))

import { AuthRetryableFetchError, type AuthError } from '@supabase/supabase-js'
import { EnvMismatchError } from '@/lib/app-env'
import { POST } from '@/app/api/plaid/reconnect/route'
import { NO_ANSWER, REFUSED_5XX } from '../stubs/no-answer'
import { answerOf, UNKNOWN_ANSWER } from './helpers/route-answers'

type Row = Record<string, unknown>
type DbError = { code?: string; message: string } | null

const ITEM: Row = {
  id: 'item-1',
  household_id: 'hh-1',
  access_token_encrypted: 'cipher',
  cursor: 'cursor-1',
  products: ['transactions'],
  plaid_env: 'sandbox',
  status: 'needs_reconnect',
}

function project(row: Row | null, columns: string): Row | null {
  if (!row) return row
  const out: Row = {}
  for (const c of columns.split(',').map((s) => s.trim())) if (c in row) out[c] = row[c]
  return out
}

function makeStandIns({
  user = { id: 'user-1' } as { id: string } | null,
  authError = null as AuthError | null,
  membership = { data: { household_id: 'hh-1' } as Row | null, error: null as DbError },
  item = ITEM as Row | null,
  readError = null as DbError,
  writeError = null as DbError,
  // A reply for the status write in place of its usual one.
  reply = undefined as unknown,
} = {}) {
  const calls = { reads: [] as unknown[][], writes: [] as { values: Row; filter: unknown[] }[] }
  createClient.mockResolvedValue({
    // getUser answers { user: null, error } on ANY auth failure, a dropped connection included.
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user }, error: authError }) },
    from: (table: string) => {
      if (table !== 'memberships') throw new Error(`unexpected table ${table}`)
      return {
        select: (cols: string) => {
          if (cols !== 'household_id') throw new Error(`unexpected columns ${cols}`)
          return { limit: (n: number) => (n === 1 ? { maybeSingle: () => Promise.resolve(membership) } : {}) }
        },
      }
    },
  })
  adminFrom.mockImplementation((table: string) => {
    if (table !== 'plaid_items') throw new Error(`unexpected table ${table}`)
    return {
      select: (cols: string) => {
        calls.reads.push(['select', cols])
        return {
          eq: (col: string, val: unknown) => {
            calls.reads.push(['eq', col, val])
            const match = item !== null && col in item && item[col] === val ? item : null
            return { maybeSingle: () => Promise.resolve({ data: readError ? null : project(match, cols), error: readError }) }
          },
        }
      },
      update: (values: Row) => ({
        eq: (col: string, val: unknown) => {
          calls.writes.push({ values, filter: ['eq', col, val] })
          return Promise.resolve(reply ?? { error: writeError })
        },
      }),
    }
  })
  return calls
}

const post = (body: unknown) =>
  POST(
    new Request('http://localhost/api/plaid/reconnect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  )
const reconnect = () => post({ itemId: 'item-1' })
const errorOf = async (res: Response) => (await res.json()).error

const NOT_FINISHED = "Couldn't finish reconnecting that bank. Please try again."

let logs: unknown[][]
beforeEach(() => {
  createClient.mockReset()
  adminFrom.mockReset()
  decrypt.mockReset().mockReturnValue('access-sandbox-1')
  storeAccounts.mockReset().mockResolvedValue(undefined)
  syncAndStore.mockReset().mockResolvedValue({ added: 4, modified: 0, removed: 0 })
  assertEnvMatchesDatabase.mockReset().mockResolvedValue(undefined)
  logs = []
  vi.spyOn(console, 'error').mockImplementation((...a) => void logs.push(a))
})
afterEach(() => vi.restoreAllMocks())

describe('POST /api/plaid/reconnect: validation before the database', () => {
  it.each([
    ['malformed JSON', '{not json'],
    ['no itemId', {}],
    ['an itemId that is not a string', { itemId: 7 }],
    ['an empty itemId', { itemId: '' }],
  ])('answers 400 for %s, in words, and changes nothing', async (_, body) => {
    const res = await post(body)
    expect(res.status).toBe(400)
    expect(await errorOf(res)).toBe(NOT_FINISHED)
    expect(createClient).not.toHaveBeenCalled()
  })
})

describe('POST /api/plaid/reconnect: sign-in, household and the bank', () => {
  it('answers 401 without a user, in words, and changes nothing', async () => {
    const calls = makeStandIns({ user: null })
    const res = await reconnect()
    expect(res.status).toBe(401)
    expect(await errorOf(res)).toBe('Your session ended. Sign in again.')
    expect(calls.writes).toHaveLength(0)
  })

  // Supabase Auth unreachable is not a signed-out person: "sign in again" would not fix anything.
  it('answers 503 and logs when the auth check itself fails, and changes nothing', async () => {
    const authError = new AuthRetryableFetchError('fetch failed', 0)
    const calls = makeStandIns({ user: null, authError })
    const res = await reconnect()
    expect(res.status).toBe(503)
    expect(await errorOf(res)).toBe(NOT_FINISHED)
    expect(logs).toContainEqual(['[plaid] reconnect auth check failed', { code: authError.code, message: 'fetch failed' }])
    expect(calls.writes).toHaveLength(0)
  })

  it('answers 500, not 403, when the membership read fails, and logs it', async () => {
    const calls = makeStandIns({ membership: { data: null, error: { code: '57014', message: 'statement timeout' } } })
    const res = await reconnect()
    expect(res.status).toBe(500)
    expect(await errorOf(res)).toBe(NOT_FINISHED)
    expect(logs).toContainEqual(['[plaid] reconnect membership read failed', { code: '57014', message: 'statement timeout' }])
    expect(calls.writes).toHaveLength(0)
  })

  it('answers 403 in words when the account has no household', async () => {
    makeStandIns({ membership: { data: null, error: null } })
    const res = await reconnect()
    expect(res.status).toBe(403)
    expect(await errorOf(res)).toBe("Your account isn't part of a household.")
  })

  // #46: "the read failed" is not "that bank is gone".
  it('answers 500, not 404, when the bank cannot be read, logs the database text and does not show it', async () => {
    const calls = makeStandIns({ readError: { code: '57014', message: 'canceling statement due to statement timeout' } })
    const res = await reconnect()
    expect(res.status).toBe(500)
    expect(await errorOf(res)).toBe(NOT_FINISHED)
    expect(logs).toContainEqual([
      '[plaid] reconnect read failed',
      { itemId: 'item-1', code: '57014', message: 'canceling statement due to statement timeout' },
    ])
    expect(calls.writes).toHaveLength(0)
  })

  it.each([
    ['does not exist', null],
    ['belongs to another household', { ...ITEM, household_id: 'hh-2' }],
  ])('answers 404 in words when the bank %s, and changes nothing', async (_, item) => {
    const calls = makeStandIns({ item })
    const res = await reconnect()
    expect(res.status).toBe(404)
    expect(await errorOf(res)).toBe("That bank isn't connected any more.")
    expect(calls.writes).toHaveLength(0)
  })

  it('answers 409 for a bank linked in another environment, and changes nothing', async () => {
    const calls = makeStandIns({ item: { ...ITEM, plaid_env: 'production' } })
    const res = await reconnect()
    expect(res.status).toBe(409)
    expect(calls.writes).toHaveLength(0)
  })

  // Before the write: otherwise a broken bank would be marked healthy and told it reconnected.
  it('answers 409 and changes nothing when the database belongs to another environment', async () => {
    const calls = makeStandIns()
    assertEnvMatchesDatabase.mockRejectedValue(new EnvMismatchError('sandbox', 'production'))
    const res = await reconnect()
    expect(res.status).toBe(409)
    expect(calls.writes).toHaveLength(0)
    expect(storeAccounts).not.toHaveBeenCalled()
  })
})

describe('POST /api/plaid/reconnect: the reconnect', () => {
  it('clears the broken flag on this bank only, catches it up from its cursor, and answers ok', async () => {
    const calls = makeStandIns()
    const res = await reconnect()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(calls.reads).toEqual([
      ['select', 'id, household_id, access_token_encrypted, cursor, products, plaid_env'],
      ['eq', 'id', 'item-1'],
    ])
    expect(calls.writes).toEqual([{ values: { status: 'ok', status_detail: null }, filter: ['eq', 'id', 'item-1'] }])
    expect(storeAccounts).toHaveBeenCalledExactlyOnceWith('hh-1', 'item-1', 'access-sandbox-1')
    expect(syncAndStore).toHaveBeenCalledExactlyOnceWith({
      id: 'item-1',
      household_id: 'hh-1',
      access_token: 'access-sandbox-1',
      cursor: 'cursor-1',
    })
  })

  // Not recorded, the bank still shows "Connection lost", and Refresh skips it: saying it reconnected
  // would leave it there.
  it('answers 500 when the flag cannot be cleared, logs it, and pulls nothing', async () => {
    makeStandIns({ writeError: { code: '42501', message: 'permission denied for table plaid_items' } })
    const res = await reconnect()
    expect(res.status).toBe(500)
    expect(await errorOf(res)).toBe(NOT_FINISHED)
    expect(logs).toContainEqual([
      '[plaid] reconnect status write failed',
      { itemId: 'item-1', code: '42501', message: 'permission denied for table plaid_items' },
    ])
    expect(storeAccounts).not.toHaveBeenCalled()
  })

  // #173: the flag may have been cleared. ReconnectButton says the reconnect may not have finished
  // and reloads to show whether the bank still needs it; the catch-up waits for the next Refresh.
  it('answers that it may not have saved when the database never answers the status write, and pulls nothing', async () => {
    makeStandIns({ reply: NO_ANSWER })
    const res = await reconnect()
    expect(await answerOf(res)).toEqual(UNKNOWN_ANSWER)
    expect(logs).toContainEqual(['[plaid] reconnect status write failed', { itemId: 'item-1', code: '', message: 'TypeError: fetch failed' }])
    expect(storeAccounts).not.toHaveBeenCalled()
  })

  // A refusal carries a code, 5xx or not: the flag was not cleared, and reconnecting again is free.
  it('answers 500 for a refused status write whose status is a 5xx, since it carries a code, and pulls nothing', async () => {
    makeStandIns({ reply: REFUSED_5XX })
    const res = await reconnect()
    expect(res.status).toBe(500)
    expect(await errorOf(res)).toBe(NOT_FINISHED)
    expect(storeAccounts).not.toHaveBeenCalled()
  })

  // The login is fixed and recorded; only the catch-up failed. A failure here would push toward a
  // disconnect and relink, which spends a slot.
  it('answers ok with a warning when the catch-up sync fails', async () => {
    makeStandIns()
    syncAndStore.mockRejectedValue(new Error('sync down'))
    expect(await (await reconnect()).json()).toEqual({
      ok: true,
      warning: 'Reconnected. New transactions have not arrived yet — Refresh will fetch them.',
    })
  })
})
