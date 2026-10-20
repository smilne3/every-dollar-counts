import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// POST /api/plaid/create-link-token: the first request of Connect a bank (LinkButton) and of
// Reconnect (ReconnectButton). Both show its words as they stand. Link has not opened yet, so no
// failure here can have connected anything or spent a slot (#51), and each says so. None may carry
// the database's words.
//
// The stand-ins are strict, as in tests/unit/reimbursable-route.test.ts (#101): the membership read
// resolves only through .limit(1).maybeSingle(), and the bank read only through .eq().maybeSingle(),
// matching on the column and value given and returning only the columns asked for.
const { createClient, adminFrom, linkTokenCreate, decrypt, assertEnvMatchesDatabase } = vi.hoisted(() => ({
  createClient: vi.fn(),
  adminFrom: vi.fn(),
  linkTokenCreate: vi.fn(),
  decrypt: vi.fn(),
  assertEnvMatchesDatabase: vi.fn(),
}))
vi.mock('@/lib/supabase/server', () => ({ createClient }))
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: { from: adminFrom } }))
vi.mock('@/lib/plaid', () => ({ plaidEnv: 'sandbox', plaidClient: { linkTokenCreate } }))
vi.mock('@/lib/crypto', () => ({ decrypt }))
// The real envGuardResponse and EnvMismatchError; only the check itself is driven.
vi.mock('@/lib/app-env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/app-env')>()),
  assertEnvMatchesDatabase,
}))

import { AuthRetryableFetchError, type AuthError } from '@supabase/supabase-js'
import { POST } from '@/app/api/plaid/create-link-token/route'

type Row = Record<string, unknown>
type DbError = { code?: string; message: string } | null

const ITEM: Row = { id: 'item-1', household_id: 'hh-1', access_token_encrypted: 'cipher', plaid_env: 'sandbox' }

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
} = {}) {
  const calls = { reads: [] as unknown[][] }
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
    }
  })
  return calls
}

const post = (body: unknown) =>
  POST(
    new Request('http://localhost/api/plaid/create-link-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  )
const add = () => post({ mode: 'add', products: ['transactions'] })
const reconnect = () => post({ mode: 'update', itemId: 'item-1' })
const errorOf = async (res: Response) => (await res.json()).error

const NOT_STARTED = "Couldn't start the bank connection. Nothing was connected — safe to try again."

let logs: unknown[][]
beforeEach(() => {
  createClient.mockReset()
  adminFrom.mockReset()
  linkTokenCreate.mockReset().mockResolvedValue({ data: { link_token: 'link-sandbox-1' } })
  decrypt.mockReset().mockReturnValue('access-sandbox-1')
  assertEnvMatchesDatabase.mockReset().mockResolvedValue(undefined)
  logs = []
  vi.spyOn(console, 'error').mockImplementation((...a) => void logs.push(a))
})
afterEach(() => vi.restoreAllMocks())

describe('POST /api/plaid/create-link-token: sign-in and household', () => {
  it('answers 401 without a user, in words, and issues no link token', async () => {
    makeStandIns({ user: null })
    const res = await add()
    expect(res.status).toBe(401)
    expect(await errorOf(res)).toBe('Your session ended. Sign in again.')
    expect(linkTokenCreate).not.toHaveBeenCalled()
  })

  // Supabase Auth unreachable is not a signed-out person: "sign in again" would not fix anything.
  it('answers 503 and logs when the auth check itself fails, and issues no link token', async () => {
    const authError = new AuthRetryableFetchError('fetch failed', 0)
    makeStandIns({ user: null, authError })
    const res = await add()
    expect(res.status).toBe(503)
    expect(await errorOf(res)).toBe(NOT_STARTED)
    expect(logs).toContainEqual(['[plaid] link token auth check failed', { code: authError.code, message: 'fetch failed' }])
    expect(linkTokenCreate).not.toHaveBeenCalled()
  })

  it('answers 500, not 403, when the membership read fails, and logs it', async () => {
    makeStandIns({ membership: { data: null, error: { code: '57014', message: 'statement timeout' } } })
    const res = await add()
    expect(res.status).toBe(500)
    expect(await errorOf(res)).toBe(NOT_STARTED)
    expect(logs).toContainEqual(['[plaid] link token membership read failed', { code: '57014', message: 'statement timeout' }])
    expect(linkTokenCreate).not.toHaveBeenCalled()
  })

  it('answers 403 in words when the account has no household', async () => {
    makeStandIns({ membership: { data: null, error: null } })
    const res = await add()
    expect(res.status).toBe(403)
    expect(await errorOf(res)).toBe("Your account isn't part of a household.")
    expect(linkTokenCreate).not.toHaveBeenCalled()
  })
})

describe('POST /api/plaid/create-link-token: a new bank', () => {
  it('answers with the link token, asking Plaid for the products picked and two years of history', async () => {
    makeStandIns()
    const res = await add()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ link_token: 'link-sandbox-1' })
    expect(linkTokenCreate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        user: { client_user_id: 'user-1' },
        products: ['transactions'],
        transactions: { days_requested: 730 },
      })
    )
  })

  it("answers 502 in words when Plaid will not issue one, and 409 when the household's connections are spent", async () => {
    makeStandIns()
    linkTokenCreate.mockRejectedValueOnce({ response: { status: 500, data: { error_code: 'INTERNAL_SERVER_ERROR' } } })
    const failed = await add()
    expect(failed.status).toBe(502)
    expect(await errorOf(failed)).toBe(NOT_STARTED)
    linkTokenCreate.mockRejectedValueOnce({ response: { status: 400, data: { error_code: 'TRIAL_CONNECTION_LIMIT' } } })
    const spent = await add()
    expect(spent.status).toBe(409)
    expect(await errorOf(spent)).toBe('You have used all 10 of your Plaid bank connections. Disconnecting one does not free a slot.')
  })
})

describe('POST /api/plaid/create-link-token: Reconnect', () => {
  it("reads the bank it was given, and opens update mode with that bank's own token", async () => {
    const calls = makeStandIns()
    const res = await reconnect()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ link_token: 'link-sandbox-1' })
    expect(calls.reads).toEqual([['select', 'access_token_encrypted, household_id, plaid_env'], ['eq', 'id', 'item-1']])
    expect(decrypt).toHaveBeenCalledWith('cipher')
    const [request] = linkTokenCreate.mock.calls[0]
    expect(request).toMatchObject({ access_token: 'access-sandbox-1' })
    expect(request).not.toHaveProperty('products')
  })

  // #46: "the read failed" is not "that bank is gone".
  it('answers 500, not 404, when the bank cannot be read, logs the database text and does not show it', async () => {
    makeStandIns({ readError: { code: '57014', message: 'canceling statement due to statement timeout' } })
    const res = await reconnect()
    expect(res.status).toBe(500)
    expect(await errorOf(res)).toBe(NOT_STARTED)
    expect(logs).toContainEqual([
      '[plaid] link token item read failed',
      { itemId: 'item-1', code: '57014', message: 'canceling statement due to statement timeout' },
    ])
    expect(linkTokenCreate).not.toHaveBeenCalled()
  })

  it.each([
    ['does not exist', null],
    ['belongs to another household', { ...ITEM, household_id: 'hh-2' }],
  ])('answers 404 in words when the bank %s, and issues no link token', async (_, item) => {
    makeStandIns({ item })
    const res = await reconnect()
    expect(res.status).toBe(404)
    expect(await errorOf(res)).toBe("That bank isn't connected any more.")
    expect(linkTokenCreate).not.toHaveBeenCalled()
  })

  it('answers 409 for a bank linked in another environment', async () => {
    makeStandIns({ item: { ...ITEM, plaid_env: 'production' } })
    const res = await reconnect()
    expect(res.status).toBe(409)
    expect(linkTokenCreate).not.toHaveBeenCalled()
  })
})
