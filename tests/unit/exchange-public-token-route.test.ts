import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// POST /api/plaid/exchange-public-token: the end of Connect a bank (LinkButton, and the OAuth return
// page). By the time it runs Link has created the Item at Plaid and spent one of the ten
// connections (#51), so every answer must be true about that, and none may carry the database's
// words. The environment guard has its own suite, tests/unit/exchange-public-token-env.test.ts.
//
// The stand-ins are strict, as in tests/unit/reimbursable-route.test.ts (#101):
// - the membership read resolves only through .limit(1).maybeSingle();
// - each insert resolves only through .select('id').single(), records the row it was given, and
//   takes the next of the test's results, so it can get what postgrest-js gives a request lost in
//   flight (#173). An insert past the last result throws, so a route that retries more than it is
//   given cannot pass;
// - the read of a stored row resolves only through .select().eq().maybeSingle(), records how, and
//   finds the row only by its item_id.
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
import { GATEWAY_502, NO_ANSWER, REFUSED_5XX } from '../stubs/no-answer'

type Row = Record<string, unknown>
type DbError = { code?: string; message: string } | null

// An insert that stored the bank, and one refused because a row with its item_id is there already.
const STORED = (id: string) => ({ data: { id }, error: null, status: 201 })
const DUPLICATE = {
  data: null,
  error: { code: '23505', message: 'duplicate key value violates unique constraint "plaid_items_item_id_key"' },
  status: 409,
}

function makeStandIns({
  user = { id: 'user-1' } as { id: string } | null,
  authError = null as AuthError | null,
  membership = { data: { household_id: 'hh-1' } as Row | null, error: null as DbError },
  // The inserts' results, first to last.
  inserts = [STORED('row-1')] as unknown[],
  // The stored row, as a read by its item_id finds it.
  storedRow = { data: { id: 'row-1' } as Row | null, error: null } as unknown,
} = {}) {
  const calls = { inserts: [] as Row[], reads: [] as unknown[][] }
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
        const result = inserts.shift()
        if (!result) throw new Error(`unexpected insert #${calls.inserts.length}`)
        return { select: (cols: string) => (cols === 'id' ? { single: () => Promise.resolve(result) } : {}) }
      },
      select: (cols: string) => {
        calls.reads.push(['select', cols])
        return {
          eq: (col: string, val: unknown) => {
            calls.reads.push(['eq', col, val])
            const found = col === 'item_id' && val === 'item-1'
            return { maybeSingle: () => Promise.resolve(found ? storedRow : { data: null, error: null }) }
          },
        }
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

const NOT_FINISHED = "Couldn't finish connecting that bank."

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
  // try again" nor "nothing was connected" is true. The database's words go to the log only. A
  // refusal is not tried again: nothing of it was written.
  it('answers 500 when the bank is refused, tears the Item down at Plaid and logs the database text', async () => {
    const notNull = { code: '23502', message: 'null value in column "household_id" violates not-null constraint' }
    const calls = makeStandIns({ inserts: [{ data: null, error: notNull, status: 400 }] })
    const res = await link()
    expect(res.status).toBe(500)
    expect(await errorOf(res)).toBe('Could not save that bank.')
    expect(calls.inserts).toHaveLength(1)
    expect(itemRemove).toHaveBeenCalledExactlyOnceWith({ access_token: 'access-sandbox-1' })
    expect(logs).toContainEqual(['[plaid] failed to store item', { itemId: 'item-1', ...notNull }])
    expect(storeAccounts).not.toHaveBeenCalled()
  })

  // A refusal carries a code, 5xx or not: nothing was stored, so we hold the only copy of the token.
  it('tears the Item down at Plaid when the insert is refused with a 5xx, since the refusal carries a code', async () => {
    const calls = makeStandIns({ inserts: [REFUSED_5XX] })
    const res = await link()
    expect(res.status).toBe(500)
    expect(await errorOf(res)).toBe('Could not save that bank.')
    expect(calls.inserts).toHaveLength(1)
    expect(itemRemove).toHaveBeenCalledExactlyOnceWith({ access_token: 'access-sandbox-1' })
  })

  // item_id is unique, so a duplicate can only be this bank, stored already. Torn down at Plaid, its
  // row would be a dead bank whose next sync fails.
  it('carries on with the bank already stored when the insert is a duplicate, and tears nothing down', async () => {
    const calls = makeStandIns({ inserts: [DUPLICATE] })
    const res = await link()
    expect(await res.json()).toEqual({ ok: true, added: 2, modified: 0, removed: 0 })
    expect(calls.reads).toEqual([['select', 'id'], ['eq', 'item_id', 'item-1']])
    expect(storeAccounts).toHaveBeenCalledExactlyOnceWith('hh-1', 'row-1', 'access-sandbox-1')
    expect(itemRemove).not.toHaveBeenCalled()
  })

  // Connected and stored: reporting a failure here would invite a duplicate link.
  it('answers ok with a warning when the first balances or transactions do not arrive', async () => {
    makeStandIns({ inserts: [STORED('row-1'), STORED('row-1')] })
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

// #173: an insert whose reply was lost, to nothing at all or to a gateway's page in PostgREST's
// place, may have stored the bank, token and all, or not. It is tried once more, and item_id, unique
// in plaid_items, settles which.
describe('POST /api/plaid/exchange-public-token: an insert whose reply was lost', () => {
  const FAILED_AFTER_LOST =
    '[plaid] FAILED to store item after an insert got no answer, which may have landed: tearing it down at Plaid. If it is in the list, disconnect it'

  it.each([
    ['no reply at all', NO_ANSWER],
    ["a gateway's 502", GATEWAY_502],
  ])('tries once more after %s, and carries on when that stores the bank', async (_, lost) => {
    const calls = makeStandIns({ inserts: [lost, STORED('row-2')] })
    const res = await link()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, added: 2, modified: 0, removed: 0 })
    expect(calls.inserts).toHaveLength(2)
    expect(calls.inserts[1]).toEqual(calls.inserts[0])
    expect(storeAccounts).toHaveBeenCalledExactlyOnceWith('hh-1', 'row-2', 'access-sandbox-1')
    expect(syncAndStore).toHaveBeenCalledExactlyOnceWith({ id: 'row-2', household_id: 'hh-1', access_token: 'access-sandbox-1' })
    expect(itemRemove).not.toHaveBeenCalled()
  })

  // postgrest-js puts the cause in `details`: the connection refused, reset or timed out.
  it('logs the lost reply with its details, which name the cause', async () => {
    makeStandIns({ inserts: [NO_ANSWER, STORED('row-2')] })
    await link()
    expect(logs).toContainEqual([
      '[plaid] no answer storing item; trying once more',
      { itemId: 'item-1', code: '', message: 'TypeError: fetch failed', details: NO_ANSWER.error.details },
    ])
  })

  // The first insert landed, so the bank is stored. Torn down at Plaid, it would be a dead row.
  it('carries on as stored when the second insert is a duplicate, reading the row by its item_id, and tears nothing down', async () => {
    const calls = makeStandIns({ inserts: [NO_ANSWER, DUPLICATE] })
    const res = await link()
    expect(await res.json()).toEqual({ ok: true, added: 2, modified: 0, removed: 0 })
    expect(calls.inserts).toHaveLength(2)
    expect(calls.reads).toEqual([['select', 'id'], ['eq', 'item_id', 'item-1']])
    expect(storeAccounts).toHaveBeenCalledExactlyOnceWith('hh-1', 'row-1', 'access-sandbox-1')
    expect(itemRemove).not.toHaveBeenCalled()
  })

  // Stored, as the duplicate proves, but with no id to pull its data under: Refresh pulls it.
  it.each([
    ['gets no answer', NO_ANSWER],
    ['is refused', REFUSED_5XX],
  ])('says the bank is connected and its balances are still to come when the read of its row %s', async (_, read) => {
    makeStandIns({ inserts: [NO_ANSWER, DUPLICATE], storedRow: read })
    const res = await link()
    expect(await res.json()).toEqual({
      ok: true,
      warning: 'Bank connected, but its balances have not arrived yet. Press Refresh in a moment.',
    })
    expect(storeAccounts).not.toHaveBeenCalled()
    expect(itemRemove).not.toHaveBeenCalled()
  })

  // Nothing holds the token but this request, and an Item nothing can remove at Plaid is billed for
  // good. A row the first insert may have left is a dead bank, which shows and can be disconnected:
  // LinkButton says to check Settings before trying again, and the log says to look.
  it.each([
    ['refused, with a code', REFUSED_5XX],
    ['lost too', NO_ANSWER],
  ])('tears the Item down at Plaid when the second insert is %s, and says the bank could not be saved', async (_, second) => {
    const calls = makeStandIns({ inserts: [NO_ANSWER, second] })
    const res = await link()
    expect(res.status).toBe(500)
    expect(await errorOf(res)).toBe('Could not save that bank.')
    expect(calls.inserts).toHaveLength(2)
    expect(itemRemove).toHaveBeenCalledExactlyOnceWith({ access_token: 'access-sandbox-1' })
    expect(logs).toContainEqual([FAILED_AFTER_LOST, expect.objectContaining({ itemId: 'item-1', message: second.error.message })])
    expect(storeAccounts).not.toHaveBeenCalled()
  })
})
