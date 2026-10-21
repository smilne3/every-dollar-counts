import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// POST /api/plaid/sync-transactions: Refresh (RefreshButton). Its refusals reach the person as they
// stand, and its counts become what the button says, so a failed read must never come back as a
// sync of nothing (#46, #119): every count would be 0.
//
// The stand-ins are strict, as in tests/unit/budgets-route.test.ts (#101):
// - the membership read resolves only through .limit(1).maybeSingle();
// - the banks read resolves only once narrowed twice, returns only the rows both filters match and
//   only the columns asked for, so a read of another household's banks, or another environment's,
//   cannot pass;
// - each status write resolves only once narrowed, and records how, and can go unanswered, as
//   postgrest-js reports a request lost in flight (#173).
const { createClient, adminFrom, storeAccounts, syncAndStore, suggestCategories, afterFns } = vi.hoisted(() => ({
  createClient: vi.fn(),
  adminFrom: vi.fn(),
  storeAccounts: vi.fn(),
  syncAndStore: vi.fn(),
  suggestCategories: vi.fn(),
  afterFns: [] as (() => unknown)[],
}))
vi.mock('next/server', async (orig) => ({
  ...(await orig<typeof import('next/server')>()),
  after: (fn: () => unknown) => void afterFns.push(fn),
}))
vi.mock('@/lib/supabase/server', () => ({ createClient }))
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: { from: adminFrom } }))
vi.mock('@/lib/ingest', () => ({ storeAccounts, syncAndStore }))
vi.mock('@/lib/crypto', () => ({ decrypt: (s: string) => `plain:${s}` }))
vi.mock('@/lib/plaid', () => ({ plaidEnv: 'sandbox' }))
vi.mock('@/lib/category-suggest', () => ({ suggestCategories }))

import { AuthRetryableFetchError, type AuthError } from '@supabase/supabase-js'
import { POST } from '@/app/api/plaid/sync-transactions/route'
import { NO_ANSWER } from '../stubs/no-answer'

type Row = Record<string, unknown>
type DbError = { code?: string; message: string } | null

const bank = (over: Row = {}): Row => ({
  id: 'item-1',
  household_id: 'hh-1',
  plaid_env: 'sandbox',
  access_token_encrypted: 'cipher-1',
  cursor: 'cursor-1',
  products: ['transactions'],
  status: 'ok',
  institution_name: 'Chase',
  ...over,
})

function project(row: Row, columns: string): Row {
  const out: Row = {}
  for (const c of columns.split(',').map((s) => s.trim())) if (c in row) out[c] = row[c]
  return out
}

function makeStandIns({
  user = { id: 'user-1' } as { id: string } | null,
  authError = null as AuthError | null,
  membership = { data: { household_id: 'hh-1' } as Row | null, error: null as DbError },
  rows = [bank()] as Row[],
  readError = null as DbError,
  writeError = null as DbError,
  // The database never answers a status write.
  noAnswer = false,
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
          eq: (c1: string, v1: unknown) => {
            calls.reads.push(['eq', c1, v1])
            return {
              eq: (c2: string, v2: unknown) => {
                calls.reads.push(['eq', c2, v2])
                const data = rows.filter((r) => r[c1] === v1 && r[c2] === v2).map((r) => project(r, cols))
                return Promise.resolve(readError ? { data: null, error: readError } : { data, error: null })
              },
            }
          },
        }
      },
      update: (values: Row) => ({
        eq: (col: string, val: unknown) => {
          calls.writes.push({ values, filter: ['eq', col, val] })
          return Promise.resolve(noAnswer ? NO_ANSWER : { error: writeError })
        },
      }),
    }
  })
  return calls
}

const refresh = () => POST()
const errorOf = async (res: Response) => (await res.json()).error
const TRY_AGAIN = "Couldn't refresh. Please try again."

let logs: unknown[][]
beforeEach(() => {
  createClient.mockReset()
  adminFrom.mockReset()
  afterFns.length = 0
  storeAccounts.mockReset().mockResolvedValue(undefined)
  syncAndStore.mockReset().mockResolvedValue({ added: 3, modified: 1, removed: 0 })
  suggestCategories.mockReset().mockResolvedValue({ status: 'off' })
  logs = []
  vi.spyOn(console, 'error').mockImplementation((...a) => void logs.push(a))
})
afterEach(() => vi.restoreAllMocks())

describe('POST /api/plaid/sync-transactions: sign-in and household', () => {
  it('answers 401 without a user, in words, and syncs nothing', async () => {
    makeStandIns({ user: null })
    const res = await refresh()
    expect(res.status).toBe(401)
    expect(await errorOf(res)).toBe('Your session ended. Sign in again.')
    expect(storeAccounts).not.toHaveBeenCalled()
    expect(afterFns).toHaveLength(0)
  })

  // Supabase Auth unreachable is not a signed-out person: "sign in again" would not fix anything.
  it('answers 503 and logs when the auth check itself fails, and syncs nothing', async () => {
    const authError = new AuthRetryableFetchError('fetch failed', 0)
    makeStandIns({ user: null, authError })
    const res = await refresh()
    expect(res.status).toBe(503)
    expect(await errorOf(res)).toBe(TRY_AGAIN)
    expect(logs).toContainEqual(['[plaid] sync auth check failed', { code: authError.code, message: 'fetch failed' }])
    expect(storeAccounts).not.toHaveBeenCalled()
  })

  it('answers 500, not 403, when the membership read fails, and logs it', async () => {
    makeStandIns({ membership: { data: null, error: { code: '57014', message: 'statement timeout' } } })
    const res = await refresh()
    expect(res.status).toBe(500)
    expect(await errorOf(res)).toBe(TRY_AGAIN)
    expect(logs).toContainEqual(['[plaid] sync membership read failed', { code: '57014', message: 'statement timeout' }])
    expect(storeAccounts).not.toHaveBeenCalled()
  })

  it('answers 403 in words when the account has no household', async () => {
    makeStandIns({ membership: { data: null, error: null } })
    const res = await refresh()
    expect(res.status).toBe(403)
    expect(await errorOf(res)).toBe("Your account isn't part of a household.")
  })
})

describe('POST /api/plaid/sync-transactions: the banks', () => {
  // #46, #119: answered as { banks: 0, added: 0 }, this read Refresh as nothing new.
  it('answers 500 when the banks cannot be read, logs it, and does not report a sync of nothing', async () => {
    makeStandIns({ readError: { code: '57014', message: 'canceling statement due to statement timeout' } })
    const res = await refresh()
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body).toEqual({ error: TRY_AGAIN })
    expect(logs).toContainEqual([
      '[plaid] sync bank read failed',
      { household_id: 'hh-1', code: '57014', message: 'canceling statement due to statement timeout' },
    ])
    expect(storeAccounts).not.toHaveBeenCalled()
  })

  it("reads only this household's banks in this environment, and syncs each from its own cursor", async () => {
    const calls = makeStandIns({
      rows: [bank(), bank({ id: 'item-2', household_id: 'hh-2' }), bank({ id: 'item-3', plaid_env: 'production' })],
    })
    const res = await refresh()
    expect(res.status).toBe(200)
    expect(calls.reads).toEqual([
      ['select', 'id, household_id, access_token_encrypted, cursor, products, status, institution_name'],
      ['eq', 'household_id', 'hh-1'],
      ['eq', 'plaid_env', 'sandbox'],
    ])
    expect(storeAccounts).toHaveBeenCalledExactlyOnceWith('hh-1', 'item-1', 'plain:cipher-1')
    expect(syncAndStore).toHaveBeenCalledExactlyOnceWith({
      id: 'item-1',
      household_id: 'hh-1',
      access_token: 'plain:cipher-1',
      cursor: 'cursor-1',
    })
  })

  // The reply RefreshButton reads, unchanged: a broken login is skipped and counted.
  it('answers ok with every count', async () => {
    makeStandIns({ rows: [bank(), bank({ id: 'item-2', status: 'needs_reconnect', institution_name: 'Wells Fargo' })] })
    const res = await refresh()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ok: true,
      banks: 2,
      added: 3,
      modified: 1,
      removed: 0,
      brokenNow: 0,
      failed: 0,
      skipped: 1,
      problems: [],
    })
    expect(afterFns).toHaveLength(1)
  })

  it('logs a status write that fails for a bank that recovered, and still counts it as synced', async () => {
    const calls = makeStandIns({
      rows: [bank({ status: 'temporarily_unavailable' })],
      writeError: { code: '42501', message: 'permission denied for table plaid_items' },
    })
    const res = await refresh()
    expect(await res.json()).toMatchObject({ ok: true, banks: 1, added: 3, failed: 0 })
    expect(calls.writes).toEqual([{ values: { status: 'ok', status_detail: null }, filter: ['eq', 'id', 'item-1'] }])
    expect(logs).toContainEqual([
      '[plaid] sync status write failed',
      { itemId: 'item-1', code: '42501', message: 'permission denied for table plaid_items' },
    ])
  })

  it('logs a status write that fails for a bank whose sync failed, and still reports the problem', async () => {
    storeAccounts.mockRejectedValue({ response: { status: 400, data: { error_code: 'ITEM_LOGIN_REQUIRED' } } })
    const calls = makeStandIns({ writeError: { code: '42501', message: 'permission denied for table plaid_items' } })
    const res = await refresh()
    expect(await res.json()).toMatchObject({
      ok: true,
      banks: 1,
      brokenNow: 1,
      problems: [{ bank: 'Chase', status: 'needs_reconnect', code: 'ITEM_LOGIN_REQUIRED' }],
    })
    expect(calls.writes).toEqual([
      { values: { status: 'needs_reconnect', status_detail: 'ITEM_LOGIN_REQUIRED' }, filter: ['eq', 'id', 'item-1'] },
    ])
    expect(logs).toContainEqual([
      '[plaid] sync status write failed',
      { itemId: 'item-1', code: '42501', message: 'permission denied for table plaid_items' },
    ])
  })
})

// #173: no write here is answered with a refusal, so none the database never answered can read as
// one. lib/ingest.ts throws on any failed write, an unanswered one included, and the bank it was
// syncing counts as needing attention: its sync may not have finished, and pressing Refresh again
// is safe. Every refusal this route gives comes from a read, before anything is written.
describe('POST /api/plaid/sync-transactions: a write the database never answered', () => {
  it('counts the bank whose sync threw as needing attention, syncs the others, and answers ok', async () => {
    syncAndStore.mockRejectedValueOnce(new Error('transactions upsert failed: TypeError: fetch failed'))
    makeStandIns({ rows: [bank(), bank({ id: 'item-2', cursor: 'cursor-2', institution_name: 'Wells Fargo' })] })
    const res = await refresh()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, banks: 2, added: 3, failed: 1, problems: [{ bank: 'Chase' }] })
    expect(syncAndStore).toHaveBeenCalledTimes(2)
  })

  // The bank's data synced, so it counts as synced; a flag the write did not set is set again by
  // the next Refresh, which still sees it as not ok.
  it('logs a status write it never answered, and still counts the bank as synced', async () => {
    makeStandIns({ rows: [bank({ status: 'temporarily_unavailable' })], noAnswer: true })
    const res = await refresh()
    expect(await res.json()).toMatchObject({ ok: true, banks: 1, added: 3, failed: 0 })
    expect(logs).toContainEqual(['[plaid] sync status write failed', { itemId: 'item-1', code: '', message: 'TypeError: fetch failed' }])
  })
})
