import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// POST /api/plaid/exchange-public-token: the end of Connect a bank (LinkButton, and the OAuth return
// page). By the time it runs Link has created the Item at Plaid and spent one of the ten
// connections (#51), so every answer must be true about that, and none may carry the database's
// words. The environment guard has its own suite, tests/unit/exchange-public-token-env.test.ts.
//
// The stand-ins are strict, as in tests/unit/reimbursable-route.test.ts (#101): the membership read
// resolves only through .limit(1).maybeSingle(), and the insert only through .select('id').single(),
// recording the row it was given.
const {
  createClient,
  adminFrom,
  itemPublicTokenExchange,
  itemRemove,
  storeAccounts,
  syncAndStore,
  recordSlotUsed,
  assertEnvMatchesDatabase,
} = vi.hoisted(() => ({
  createClient: vi.fn(),
  adminFrom: vi.fn(),
  itemPublicTokenExchange: vi.fn(),
  itemRemove: vi.fn(),
  storeAccounts: vi.fn(),
  syncAndStore: vi.fn(),
  recordSlotUsed: vi.fn(),
  assertEnvMatchesDatabase: vi.fn(),
}))
vi.mock('@/lib/supabase/server', () => ({ createClient }))
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: { from: adminFrom } }))
vi.mock('@/lib/plaid', () => ({ plaidEnv: 'sandbox', plaidClient: { itemPublicTokenExchange, itemRemove } }))
vi.mock('@/lib/crypto', () => ({ encrypt: (s: string) => `enc:${s}` }))
vi.mock('@/lib/ingest', () => ({ storeAccounts, syncAndStore }))
vi.mock('@/lib/plaid-slots', () => ({ recordSlotUsed, LIFETIME_SLOTS: 10 }))
vi.mock('@/lib/app-env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/app-env')>()),
  assertEnvMatchesDatabase,
}))

import { AuthRetryableFetchError, type AuthError } from '@supabase/supabase-js'
import { POST, maxDuration } from '@/app/api/plaid/exchange-public-token/route'
import { EXCHANGE_TIMEOUT_MS } from '@/components/plaid-link-context'

type Row = Record<string, unknown>
type DbError = { code?: string; message: string } | null

function makeStandIns({
  user = { id: 'user-1' } as { id: string } | null,
  authError = null as AuthError | null,
  membership = { data: { household_id: 'hh-1' } as Row | null, error: null as DbError },
  insertResult = { data: { id: 'row-1' } as Row | null, error: null as DbError },
} = {}) {
  const calls = { inserts: [] as Row[] }
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
      insert: (row: Row) => {
        calls.inserts.push(row)
        return { select: (cols: string) => (cols === 'id' ? { single: () => Promise.resolve(insertResult) } : {}) }
      },
    }
  })
  return calls
}

const post = (body: unknown) =>
  POST(
    new Request('http://localhost/api/plaid/exchange-public-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  )
const link = (over: Record<string, unknown> = {}) =>
  post({ public_token: 'public-sandbox-1', institution_name: 'Test Bank', products: ['transactions'], ...over })
const errorOf = async (res: Response) => (await res.json()).error

const NOT_FINISHED = "Couldn't finish connecting that bank. Check Settings before trying again."

let logs: unknown[][]
beforeEach(() => {
  createClient.mockReset()
  adminFrom.mockReset()
  itemPublicTokenExchange.mockReset().mockResolvedValue({ data: { access_token: 'access-sandbox-1', item_id: 'item-1' } })
  itemRemove.mockReset().mockResolvedValue({ data: { removed: true } })
  storeAccounts.mockReset().mockResolvedValue(undefined)
  syncAndStore.mockReset().mockResolvedValue({ added: 2, modified: 0, removed: 0 })
  recordSlotUsed.mockReset().mockResolvedValue(undefined)
  assertEnvMatchesDatabase.mockReset().mockResolvedValue(undefined)
  logs = []
  vi.spyOn(console, 'error').mockImplementation((...a) => void logs.push(a))
})
afterEach(() => vi.restoreAllMocks())

// The browser waits longer than this before it says the bank may have connected, so the limit is
// pinned in code, where a dashboard default cannot move it (#165).
it('pins its time limit at 300 seconds', () => {
  expect(maxDuration).toBe(300)
})

// When the browser gives up, the exchange must have finished or been stopped, so the browser waits
// longer, with a minute for the request to reach the route (components/plaid-link-context.ts).
it('is outlasted by the browser’s wait for it, by at least a minute', () => {
  expect(EXCHANGE_TIMEOUT_MS - maxDuration * 1000).toBeGreaterThanOrEqual(60_000)
})

describe('POST /api/plaid/exchange-public-token: before the exchange', () => {
  it.each([
    ['malformed JSON', '{not json'],
    ['no public token', { institution_name: 'Test Bank' }],
    ['a public token that is not a string', { public_token: 7 }],
    ['an empty public token', { public_token: '' }],
  ])('answers 400 for %s, in words, and exchanges nothing', async (_, body) => {
    const res = await post(body)
    expect(res.status).toBe(400)
    expect(await errorOf(res)).toBe(NOT_FINISHED)
    expect(createClient).not.toHaveBeenCalled()
    expect(itemPublicTokenExchange).not.toHaveBeenCalled()
  })

  it('answers 401 without a user, in words, and exchanges nothing', async () => {
    makeStandIns({ user: null })
    const res = await link()
    expect(res.status).toBe(401)
    expect(await errorOf(res)).toBe('Your session ended. Sign in again.')
    expect(itemPublicTokenExchange).not.toHaveBeenCalled()
  })

  // Supabase Auth unreachable is not a signed-out person: "sign in again" would not fix anything.
  it('answers 503 and logs when the auth check itself fails, and exchanges nothing', async () => {
    const authError = new AuthRetryableFetchError('fetch failed', 0)
    makeStandIns({ user: null, authError })
    const res = await link()
    expect(res.status).toBe(503)
    expect(await errorOf(res)).toBe(NOT_FINISHED)
    expect(logs).toContainEqual(['[plaid] exchange auth check failed', { code: authError.code, message: 'fetch failed' }])
    expect(itemPublicTokenExchange).not.toHaveBeenCalled()
  })

  it('answers 500, not 403, when the membership read fails, and logs it', async () => {
    makeStandIns({ membership: { data: null, error: { code: '57014', message: 'statement timeout' } } })
    const res = await link()
    expect(res.status).toBe(500)
    expect(await errorOf(res)).toBe(NOT_FINISHED)
    expect(logs).toContainEqual(['[plaid] exchange membership read failed', { code: '57014', message: 'statement timeout' }])
    expect(itemPublicTokenExchange).not.toHaveBeenCalled()
  })

  it('answers 403 in words when the account has no household', async () => {
    makeStandIns({ membership: { data: null, error: null } })
    const res = await link()
    expect(res.status).toBe(403)
    expect(await errorOf(res)).toBe("Your account isn't part of a household.")
    expect(itemPublicTokenExchange).not.toHaveBeenCalled()
  })

  it('answers 502 in words when Plaid will not exchange the token, and stores nothing', async () => {
    const calls = makeStandIns()
    itemPublicTokenExchange.mockRejectedValue({ response: { status: 400, data: { error_code: 'INVALID_PUBLIC_TOKEN' } } })
    const res = await link()
    expect(res.status).toBe(502)
    expect(await errorOf(res)).toBe(NOT_FINISHED)
    expect(calls.inserts).toHaveLength(0)
  })
})

describe('POST /api/plaid/exchange-public-token: the bank', () => {
  it('exchanges the token, records the spent connection, stores the bank, pulls its data and answers with the counts', async () => {
    const calls = makeStandIns()
    const res = await link()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, added: 2, modified: 0, removed: 0 })
    expect(itemPublicTokenExchange).toHaveBeenCalledExactlyOnceWith({ public_token: 'public-sandbox-1' })
    expect(recordSlotUsed).toHaveBeenCalledExactlyOnceWith({ householdId: 'hh-1', itemId: 'item-1', institutionName: 'Test Bank' })
    expect(calls.inserts).toEqual([
      {
        household_id: 'hh-1',
        item_id: 'item-1',
        access_token_encrypted: 'enc:access-sandbox-1',
        institution_name: 'Test Bank',
        products: ['transactions'],
        plaid_env: 'sandbox',
      },
    ])
    expect(storeAccounts).toHaveBeenCalledExactlyOnceWith('hh-1', 'row-1', 'access-sandbox-1')
    expect(syncAndStore).toHaveBeenCalledExactlyOnceWith({ id: 'row-1', household_id: 'hh-1', access_token: 'access-sandbox-1' })
  })

  it('stores a bank name that is not a string as no name', async () => {
    const calls = makeStandIns()
    await link({ institution_name: { evil: true } })
    expect(calls.inserts[0].institution_name).toBeNull()
  })

  // The slot is spent and, if the teardown failed, the Item is still live at Plaid: neither "safe to
  // try again" nor "nothing was connected" is true. The database's words go to the log only.
  it('answers 500 when the bank cannot be stored, tears the Item down at Plaid and logs the database text', async () => {
    makeStandIns({ insertResult: { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } } })
    const res = await link()
    expect(res.status).toBe(500)
    expect(await errorOf(res)).toBe('Could not save that bank.')
    expect(itemRemove).toHaveBeenCalledExactlyOnceWith({ access_token: 'access-sandbox-1' })
    expect(logs).toContainEqual([
      '[plaid] failed to store item',
      { itemId: 'item-1', code: '23505', message: 'duplicate key value violates unique constraint' },
    ])
    expect(storeAccounts).not.toHaveBeenCalled()
  })

  // Connected and stored: reporting a failure here would invite a duplicate link.
  it('answers ok with a warning when the first balances or transactions do not arrive', async () => {
    makeStandIns()
    storeAccounts.mockRejectedValueOnce(new Error('accounts down'))
    expect(await (await link()).json()).toEqual({
      ok: true,
      warning: 'Bank connected, but its balances have not arrived yet. Press Refresh in a moment.',
    })
    syncAndStore.mockRejectedValueOnce(new Error('sync down'))
    expect(await (await link()).json()).toEqual({
      ok: true,
      warning:
        'Bank connected. Transactions can take a few minutes to a few hours to arrive on a first connection — press Refresh again shortly. Do not re-link.',
    })
  })
})
