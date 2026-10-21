import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// POST /api/plaid/remove-item: Disconnect (BankList). It removes the Item at Plaid, then deletes the
// row, and BankList shows its words as they stand, so each must be true of the bank on its path
// (#165): until Plaid removes it the bank is still connected; after that it is not, whatever happens
// to the row. None may carry the database's words.
//
// The stand-ins are strict, as in tests/unit/reimbursable-route.test.ts (#101):
// - the membership read resolves only through .limit(1).maybeSingle(), and the item read only
//   through .eq().maybeSingle(), so .single(), which errors on no row and would turn "not found"
//   into a failed read, cannot pass;
// - the item read matches on the column and value it is given and returns only the columns asked
//   for, so reading the wrong row, or too few columns, starves the checks that follow;
// - the delete resolves only once narrowed, and records how, so a delete of the wrong row cannot
//   pass, and can go unanswered, as postgrest-js reports a request lost in flight (#173).
const { createClient, adminFrom, itemRemove, decrypt } = vi.hoisted(() => ({
  createClient: vi.fn(),
  adminFrom: vi.fn(),
  itemRemove: vi.fn(),
  decrypt: vi.fn(),
}))
vi.mock('@/lib/supabase/server', () => ({ createClient }))
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: { from: adminFrom } }))
vi.mock('@/lib/plaid', () => ({ plaidEnv: 'sandbox', plaidClient: { itemRemove } }))
vi.mock('@/lib/crypto', () => ({ decrypt }))

import { AuthRetryableFetchError, type AuthError } from '@supabase/supabase-js'
import { MAY_NOT_HAVE_SAVED } from '@/lib/save-response'
import { POST } from '@/app/api/plaid/remove-item/route'
import { NO_ANSWER } from '../stubs/no-answer'

type Row = Record<string, unknown>
type DbError = { code?: string; message: string } | null

const ITEM: Row = {
  id: 'item-1',
  household_id: 'hh-1',
  access_token_encrypted: 'cipher',
  plaid_env: 'sandbox',
  institution_name: 'Chase',
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
  deleteError = null as DbError,
  // The database never answers the delete.
  deleteUnanswered = false,
} = {}) {
  const calls = { membership: [] as unknown[][], reads: [] as unknown[][], deletes: [] as unknown[][] }
  createClient.mockResolvedValue({
    // getUser answers { user: null, error } on ANY auth failure, a dropped connection included.
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user }, error: authError }) },
    from: (table: string) => {
      if (table !== 'memberships') throw new Error(`unexpected table ${table}`)
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
      delete: () => ({
        eq: (col: string, val: unknown) => {
          calls.deletes.push(['eq', col, val])
          return Promise.resolve(deleteUnanswered ? NO_ANSWER : { error: deleteError })
        },
      }),
    }
  })
  return calls
}

// Shaped as the Plaid SDK throws: axios errors carry `response` whenever something answered. Only a
// 4xx means Plaid did nothing.
const plaidRefusal = { response: { status: 429, data: { error_type: 'RATE_LIMIT_EXCEEDED', error_code: 'RATE_LIMIT' } } }
const plaidServerError = { response: { status: 500, data: { error_type: 'API_ERROR', error_code: 'INTERNAL_SERVER_ERROR' } } }
const gatewayTimeout = { response: { status: 504, data: '<html>Gateway Timeout</html>' } }
const noAnswer = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
const alreadyGone = { response: { status: 400, data: { error_type: 'ITEM_ERROR', error_code: 'ITEM_NOT_FOUND' } } }

const post = (body: unknown) =>
  POST(
    new Request('http://localhost/api/plaid/remove-item', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  )
const disconnect = () => post({ itemId: 'item-1' })
const errorOf = async (res: Response) => (await res.json()).error

const NOT_DISCONNECTED = 'That bank was not disconnected. Please try again.'

let logs: unknown[][]
beforeEach(() => {
  createClient.mockReset()
  adminFrom.mockReset()
  itemRemove.mockReset().mockResolvedValue({ data: { removed: true } })
  decrypt.mockReset().mockReturnValue('access-sandbox-1')
  logs = []
  vi.spyOn(console, 'error').mockImplementation((...a) => void logs.push(a))
})
afterEach(() => vi.restoreAllMocks())

describe('POST /api/plaid/remove-item: validation before the database', () => {
  it.each([
    ['malformed JSON', '{not json'],
    ['no itemId', {}],
    ['an itemId that is not a string', { itemId: 7 }],
    ['an empty itemId', { itemId: '' }],
  ])('answers 400 for %s, in words, and touches nothing', async (_, body) => {
    const res = await post(body)
    expect(res.status).toBe(400)
    expect(await errorOf(res)).toBe('That bank was not disconnected. Refresh and try again.')
    expect(createClient).not.toHaveBeenCalled()
    expect(itemRemove).not.toHaveBeenCalled()
  })
})

describe('POST /api/plaid/remove-item: before Plaid is asked, the bank is still connected', () => {
  it('answers 401 without a user, in words, and removes nothing', async () => {
    const calls = makeStandIns({ user: null })
    const res = await disconnect()
    expect(res.status).toBe(401)
    expect(await errorOf(res)).toBe('Your session ended. Sign in again.')
    expect(itemRemove).not.toHaveBeenCalled()
    expect(calls.deletes).toHaveLength(0)
  })

  // Supabase Auth unreachable is not a signed-out person: "sign in again" would not fix anything.
  it('answers 503 and logs when the auth check itself fails, and removes nothing', async () => {
    const authError = new AuthRetryableFetchError('fetch failed', 0)
    const calls = makeStandIns({ user: null, authError })
    const res = await disconnect()
    expect(res.status).toBe(503)
    expect(await errorOf(res)).toBe(NOT_DISCONNECTED)
    expect(logs).toContainEqual(['[plaid] remove-item auth check failed', { code: authError.code, message: 'fetch failed' }])
    expect(itemRemove).not.toHaveBeenCalled()
    expect(calls.deletes).toHaveLength(0)
  })

  // #46: "the read failed" is not "you have no household".
  it('answers 500, not 403, when the membership read fails, logs it and removes nothing', async () => {
    const calls = makeStandIns({ membership: { data: null, error: { code: '57014', message: 'statement timeout' } } })
    const res = await disconnect()
    expect(res.status).toBe(500)
    expect(await errorOf(res)).toBe(NOT_DISCONNECTED)
    expect(logs).toContainEqual(['[plaid] remove-item membership read failed', { code: '57014', message: 'statement timeout' }])
    expect(itemRemove).not.toHaveBeenCalled()
    expect(calls.deletes).toHaveLength(0)
  })

  it('answers 403 in words when the account has no household', async () => {
    makeStandIns({ membership: { data: null, error: null } })
    const res = await disconnect()
    expect(res.status).toBe(403)
    expect(await errorOf(res)).toBe("Your account isn't part of a household.")
    expect(itemRemove).not.toHaveBeenCalled()
  })

  // #46 again: "the read failed" is not "that bank is gone", which would reload it off the list.
  it('answers 500, not 404, when the bank cannot be read, logs the database text and does not show it', async () => {
    const calls = makeStandIns({ readError: { code: '57014', message: 'canceling statement due to statement timeout' } })
    const res = await disconnect()
    expect(res.status).toBe(500)
    expect(await errorOf(res)).toBe(NOT_DISCONNECTED)
    expect(logs).toContainEqual([
      '[plaid] remove-item read failed',
      { itemId: 'item-1', code: '57014', message: 'canceling statement due to statement timeout' },
    ])
    expect(itemRemove).not.toHaveBeenCalled()
    expect(calls.deletes).toHaveLength(0)
  })

  it.each([
    ['does not exist', null],
    ['belongs to another household', { ...ITEM, household_id: 'hh-2' }],
  ])('answers 404 in words when the bank %s, and removes nothing', async (_, item) => {
    const calls = makeStandIns({ item })
    const res = await disconnect()
    expect(res.status).toBe(404)
    expect(await errorOf(res)).toBe("That bank isn't connected any more.")
    expect(itemRemove).not.toHaveBeenCalled()
    expect(calls.deletes).toHaveLength(0)
  })

  // The token is the only way to revoke the connection: without it the row must stay.
  it('answers 500 and keeps the row when the saved credential cannot be read', async () => {
    const calls = makeStandIns()
    decrypt.mockImplementation(() => {
      throw new Error('bad decrypt')
    })
    const res = await disconnect()
    expect(res.status).toBe(500)
    expect(await errorOf(res)).toBe('Could not read this bank’s saved credential, so it was NOT disconnected.')
    expect(itemRemove).not.toHaveBeenCalled()
    expect(calls.deletes).toHaveLength(0)
  })

  it('answers 502 and keeps the row when Plaid refuses with a 4xx: nothing changed there', async () => {
    const calls = makeStandIns()
    itemRemove.mockRejectedValue(plaidRefusal)
    const res = await disconnect()
    expect(res.status).toBe(502)
    expect(await errorOf(res)).toBe('Plaid could not disconnect that bank just now. Nothing was changed — try again.')
    expect(calls.deletes).toHaveLength(0)
  })
})

describe('POST /api/plaid/remove-item: once Plaid may have removed it', () => {
  // After a 5xx, or no answer at all, the removal may have landed, so "nothing was changed" would be
  // a guess. Trying again settles it: an Item already gone is swallowed, and the row goes.
  it.each([
    ["Plaid's own server error", plaidServerError],
    ["a gateway's timeout", gatewayTimeout],
    ['no answer at all', noAnswer],
  ])('answers 502 and keeps the row after %s, and says it may or may not be disconnected', async (_, failure) => {
    const calls = makeStandIns()
    itemRemove.mockRejectedValue(failure)
    const res = await disconnect()
    expect(res.status).toBe(502)
    expect(await errorOf(res)).toBe("Plaid didn't confirm it, so that bank may or may not be disconnected. Try again.")
    expect(calls.deletes).toHaveLength(0)
  })

  it('deletes the row when the bank is already gone at Plaid', async () => {
    const calls = makeStandIns()
    itemRemove.mockRejectedValue(alreadyGone)
    const res = await disconnect()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(calls.deletes).toEqual([['eq', 'id', 'item-1']])
  })

  it("removes the bank at Plaid with its own token, then deletes only that bank's row", async () => {
    const calls = makeStandIns()
    const res = await disconnect()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(calls.membership).toEqual([['select', 'household_id'], ['limit', 1]])
    expect(calls.reads).toEqual([['select', 'id, household_id, access_token_encrypted, plaid_env'], ['eq', 'id', 'item-1']])
    expect(decrypt).toHaveBeenCalledWith('cipher')
    expect(itemRemove).toHaveBeenCalledExactlyOnceWith({ access_token: 'access-sandbox-1' })
    expect(calls.deletes).toEqual([['eq', 'id', 'item-1']])
  })

  // It is disconnected at Plaid, but still listed. Saying it was not disconnected would be false.
  it('answers 500 when the row cannot be deleted after Plaid removed it, says so, logs it and does not show the database text', async () => {
    makeStandIns({ deleteError: { code: '42501', message: 'permission denied for table plaid_items' } })
    const res = await disconnect()
    expect(res.status).toBe(500)
    expect(await errorOf(res)).toBe('That bank was disconnected at Plaid but is still in your list. Please try again.')
    expect(logs).toContainEqual([
      '[plaid] remove-item delete failed',
      { itemId: 'item-1', code: '42501', message: 'permission denied for table plaid_items' },
    ])
  })

  // #173: Plaid has removed it, and the delete may have taken the row, and the accounts and
  // transactions under it, or not. "Still in your list" would be a guess: BankList says it may or
  // may not have been disconnected and reloads to show which.
  it('answers that it may not have saved when the database never answers the delete, and logs it', async () => {
    const calls = makeStandIns({ deleteUnanswered: true })
    const res = await disconnect()
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: MAY_NOT_HAVE_SAVED, unknown: true })
    expect(itemRemove).toHaveBeenCalledExactlyOnceWith({ access_token: 'access-sandbox-1' })
    expect(calls.deletes).toEqual([['eq', 'id', 'item-1']])
    expect(logs).toContainEqual(['[plaid] remove-item delete failed', { itemId: 'item-1', code: '', message: 'TypeError: fetch failed' }])
  })
})
