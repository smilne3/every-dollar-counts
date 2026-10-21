import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The only route that sets a category on one transaction (#28 spec §6.1, PR 1). The stand-in is
// strict on purpose, because a permissive one hid three dead guards here before (#99):
// - select() PROJECTS the fixture to the requested columns, so a narrowed read starves the guards;
// - the categories read only resolves through .eq('household_id', …).order('sort_order');
// - update() resolves only through two .eq()s and an .or(); the tests below assert which columns
//   and values those are (#140 tracks tightening the stand-in itself).
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
const { assertEnvMatchesDatabase } = vi.hoisted(() => ({ assertEnvMatchesDatabase: vi.fn() }))
vi.mock('@/lib/plaid', () => ({ plaidEnv: 'production' }))
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: {} }))
vi.mock('@/lib/app-env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/app-env')>()),
  assertEnvMatchesDatabase,
}))
// learnableRule is the real gate unless a test makes it throw; beforeEach puts the real one back.
const { learnableRule, realGate } = vi.hoisted(() => ({
  learnableRule: vi.fn(),
  realGate: { fn: null as null | ((...a: never[]) => unknown) },
}))
vi.mock('@/lib/category-rules', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/category-rules')>()
  realGate.fn = real.learnableRule as (...a: never[]) => unknown
  return { ...real, learnableRule }
})

import { AuthApiError, AuthRetryableFetchError, AuthSessionMissingError, type AuthError } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { EnvMismatchError } from '@/lib/app-env'
import { MAY_NOT_HAVE_SAVED } from '@/lib/save-response'
import { POST } from '@/app/api/transactions/categorize/route'
import { NO_ANSWER } from '../stubs/no-answer'

type Row = Record<string, unknown>
type Err = { message: string } | null

function project(data: Row | null, columns: string): Row | null {
  if (!data) return data
  const out: Row = {}
  for (const c of columns.split(',').map((s) => s.trim())) if (c in data) out[c] = data[c]
  return out
}

const CARD_FILTER = 'pfc_detailed.is.null,pfc_detailed.neq.LOAN_PAYMENTS_CREDIT_CARD_PAYMENT'

function makeSupabase({
  user = { id: 'user-1' } as { id: string } | null,
  authError = null as AuthError | null,
  row = null as Row | null,
  readError = null as Err,
  categories = [
    { id: 'c1', name: 'Food & Drink', pfc_primary: 'FOOD_AND_DRINK', sort_order: 1 },
    { id: 'c2', name: 'Grocery', pfc_primary: null, sort_order: 2 },
  ] as Row[] | null,
  categoriesError = null as Err,
  update = { error: null as Err, count: 1 as number | null },
  upsert = { data: [{ id: 'r-new' }] as Row[] | null, error: null as ({ code?: string; message: string } | null) },
}: Partial<{
  user: { id: string } | null
  authError: AuthError | null
  row: Row | null
  readError: Err
  categories: Row[] | null
  categoriesError: Err
  update: { error: Err; count: number | null }
  upsert: { data: Row[] | null; error: { code?: string; message: string } | null } | 'throw'
}> = {}) {
  const calls = {
    readColumns: '' as string,
    categories: [] as unknown[][],
    updates: [] as { payload: Row; options: unknown; filters: unknown[][] }[],
    upserts: [] as { payload: Row; options: unknown; select: string }[],
  }
  const client = {
    // getUser answers { user: null, error } on ANY auth failure, a dropped connection included.
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user }, error: authError }) },
    from: vi.fn((table: string) => {
      if (table === 'category_rules') {
        return {
          upsert: (payload: Row, options: unknown) => ({
            select: (cols: string) => {
              calls.upserts.push({ payload, options, select: cols })
              return upsert === 'throw' ? Promise.reject(new Error('socket hang up')) : Promise.resolve(upsert)
            },
          }),
        }
      }
      if (table === 'categories') {
        return {
          select: (cols: string) => {
            calls.categories.push(['select', cols])
            return {
              eq: (c: string, v: unknown) => {
                calls.categories.push(['eq', c, v])
                return {
                  order: (c2: string) => {
                    calls.categories.push(['order', c2])
                    return Promise.resolve({ data: categories, error: categoriesError })
                  },
                }
              },
            }
          },
        }
      }
      return {
        select: (cols: string) => {
          calls.readColumns = cols
          return { eq: () => ({ maybeSingle: () => Promise.resolve({ data: project(row, cols), error: readError }) }) }
        },
        update: (payload: Row, options: unknown) => {
          const entry = { payload, options, filters: [] as unknown[][] }
          calls.updates.push(entry)
          return {
            eq: (c1: string, v1: unknown) => {
              entry.filters.push(['eq', c1, v1])
              return {
                eq: (c2: string, v2: unknown) => {
                  entry.filters.push(['eq', c2, v2])
                  return {
                    or: (f: string) => {
                      entry.filters.push(['or', f])
                      return Promise.resolve(update)
                    },
                  }
                },
              }
            },
          }
        },
      }
    }),
  }
  vi.mocked(createClient).mockResolvedValue(client as never)
  return calls
}

const ROW = {
  id: 'txn-1',
  household_id: 'hh-1',
  merchant_name: 'Safeway',
  pfc_primary: 'FOOD_AND_DRINK',
  pfc_detailed: 'FOOD_AND_DRINK_GROCERIES',
  removed: false,
  user_category: null,
}

const post = (body: unknown) =>
  POST(new Request('http://localhost/api/transactions/categorize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }))

let logs: unknown[][]
beforeEach(() => {
  vi.mocked(createClient).mockReset()
  logs = []
  assertEnvMatchesDatabase.mockReset().mockResolvedValue(undefined)
  learnableRule.mockReset().mockImplementation(realGate.fn!)
  vi.spyOn(console, 'warn').mockImplementation((...a) => void logs.push(a))
  vi.spyOn(console, 'error').mockImplementation((...a) => void logs.push(a))
  vi.spyOn(console, 'info').mockImplementation((...a) => void logs.push(a))
})
afterEach(() => vi.restoreAllMocks())

describe('POST /api/transactions/categorize: validation before the database', () => {
  it.each([
    ['malformed JSON', '{not json'],
    ['no transactionId', { category: 'Grocery' }],
    ['an empty category', { transactionId: 'txn-1', category: '' }],
    ['a whitespace-only category', { transactionId: 'txn-1', category: '   ' }],
  ])('answers 400 for %s without touching the database', async (_, body) => {
    const res = await post(body)
    expect(res.status).toBe(400)
    expect(createClient).not.toHaveBeenCalled()
  })
})

describe('POST /api/transactions/categorize', () => {
  it('answers 401 without a user, with a readable message', async () => {
    makeSupabase({ user: null })
    const res = await post({ transactionId: 'txn-1', category: 'Grocery' })
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe('Your session ended. Sign in again.')
  })

  // What supabase-js returns for a request with no session cookie, or one whose session was ended.
  it('answers 401 when the auth error is a missing session', async () => {
    const calls = makeSupabase({ user: null, authError: new AuthSessionMissingError() })
    const res = await post({ transactionId: 'txn-1', category: 'Grocery' })
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe('Your session ended. Sign in again.')
    expect(calls.updates).toHaveLength(0)
  })

  // A dead refresh token on an expired session comes back as the refresh call's own 4xx error, not
  // as a missing session. The session has still ended: "try again" would never succeed.
  it.each(['refresh_token_not_found', 'refresh_token_already_used', 'session_expired'])(
    'answers 401 for a %s auth error',
    async (code) => {
      const calls = makeSupabase({ user: null, authError: new AuthApiError('Invalid Refresh Token', 400, code) })
      const res = await post({ transactionId: 'txn-1', category: 'Grocery' })
      expect(res.status).toBe(401)
      expect((await res.json()).error).toBe('Your session ended. Sign in again.')
      expect(calls.updates).toHaveLength(0)
    }
  )

  // Supabase Auth unreachable is not a signed-out person: telling them to sign in again would send
  // them round a login that does not fix anything.
  it('answers 503 and logs when the auth check itself fails', async () => {
    const calls = makeSupabase({ user: null, authError: new AuthRetryableFetchError('fetch failed', 0) })
    const res = await post({ transactionId: 'txn-1', category: 'Grocery' })
    expect(res.status).toBe(503)
    expect((await res.json()).error).toBe('That could not be saved. Please try again.')
    expect(console.error).toHaveBeenCalledWith('[categorize] auth check failed', 'fetch failed')
    expect(calls.updates).toHaveLength(0)
  })

  it('answers 500, not 404, when the read fails, and writes nothing', async () => {
    const calls = makeSupabase({ readError: { message: 'boom' } })
    const res = await post({ transactionId: 'txn-1', category: 'Grocery' })
    expect(res.status).toBe(500)
    expect(calls.updates).toHaveLength(0)
  })

  it('answers 404 when the transaction does not exist', async () => {
    makeSupabase({ row: null })
    expect((await post({ transactionId: 'txn-1', category: 'Grocery' })).status).toBe(404)
  })

  it('reads every column the later steps need', async () => {
    const calls = makeSupabase({ row: ROW })
    await post({ transactionId: 'txn-1', category: 'Grocery' })
    for (const col of ['id', 'household_id', 'merchant_name', 'pfc_primary', 'pfc_detailed', 'removed', 'user_category']) {
      expect(calls.readColumns.split(',').map((c) => c.trim())).toContain(col)
    }
  })

  it('answers 400 for a row the bank removed, and writes nothing', async () => {
    const calls = makeSupabase({ row: { ...ROW, removed: true } })
    const res = await post({ transactionId: 'txn-1', category: 'Grocery' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Your bank removed that transaction. Refresh and try again.')
    expect(calls.updates).toHaveLength(0)
  })

  // #59: on an unpicked card payment, any user_category re-enters it into every total. An already-
  // picked one stays refused: changing it can move it between spending and income, and a pick
  // cannot be cleared back to the exclusion (spec decision 7).
  it.each([
    ['an unpicked card payment', null],
    ['a card payment someone already filed by hand', 'Shopping'],
  ])('answers 400 for %s, and writes nothing', async (_, pick) => {
    const calls = makeSupabase({
      row: { ...ROW, pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', user_category: pick },
    })
    const res = await post({ transactionId: 'txn-1', category: 'Grocery' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('A credit-card payment is already kept out of spending and income.')
    expect(calls.updates).toHaveLength(0)
  })

  it("reads the row's household's categories, in order", async () => {
    const calls = makeSupabase({ row: ROW })
    await post({ transactionId: 'txn-1', category: 'Grocery' })
    expect(calls.categories).toEqual([
      ['select', 'id, name, pfc_primary, sort_order'],
      ['eq', 'household_id', 'hh-1'],
      ['order', 'sort_order'],
    ])
  })

  it('answers 500 when the categories read fails, and writes nothing', async () => {
    const calls = makeSupabase({ row: ROW, categoriesError: { message: 'boom' } })
    const res = await post({ transactionId: 'txn-1', category: 'Grocery' })
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('That could not be saved. Please try again.')
    expect(calls.updates).toHaveLength(0)
  })

  // A name that is not one of the household's categories, including the display fallback
  // 'Uncategorized' (spec decision 7: clearing is not supported).
  it.each(['Uncategorized', 'Not A Category'])('answers 400 for %s, and writes nothing', async (category) => {
    const calls = makeSupabase({ row: ROW })
    const res = await post({ transactionId: 'txn-1', category })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('That category no longer exists. Refresh and try again.')
    expect(calls.updates).toHaveLength(0)
  })

  it('writes the category with every guard inside the update', async () => {
    const calls = makeSupabase({ row: ROW })
    const res = await post({ transactionId: 'txn-1', category: '  Grocery  ' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, learned: 'created' })
    expect(calls.updates).toEqual([
      {
        payload: { user_category: 'Grocery' },
        options: { count: 'exact' },
        filters: [['eq', 'id', 'txn-1'], ['eq', 'removed', false], ['or', CARD_FILTER]],
      },
    ])
  })

  it('answers 500 for a failed write, without the database text', async () => {
    makeSupabase({ row: ROW, update: { error: { message: 'new row violates row-level security' }, count: null } })
    const res = await post({ transactionId: 'txn-1', category: 'Grocery' })
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('That could not be saved. Please try again.')
  })

  // #173: the pick may have landed, so the outcome is unknown, never a refusal. Only a saved pick
  // teaches, so nothing is learned from it, and the change log records only what was written.
  it('answers that it may not have saved when the database never answers the write, and learns nothing', async () => {
    const calls = makeSupabase({ row: ROW, update: NO_ANSWER })
    const res = await post({ transactionId: 'txn-1', category: 'Grocery' })
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: MAY_NOT_HAVE_SAVED, unknown: true })
    expect(calls.upserts).toHaveLength(0)
    expect(logs).toContainEqual(['[categorize] update failed', 'TypeError: fetch failed'])
    expect(logs.some((l) => l[0] === '[categorize] changed')).toBe(false)
  })

  // The row changed between the read and the write: Plaid removed or re-tagged it.
  it('answers 409 when the write matched no rows', async () => {
    makeSupabase({ row: ROW, update: { error: null, count: 0 } })
    const res = await post({ transactionId: 'txn-1', category: 'Grocery' })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('This transaction just changed. Refresh and try again.')
  })

  // A count the server did not send is not a count of one. Treating it as a write would report a
  // save that may never have happened.
  it('answers 409 when the write returns no count', async () => {
    makeSupabase({ row: ROW, update: { error: null, count: null } })
    const res = await post({ transactionId: 'txn-1', category: 'Grocery' })
    expect(res.status).toBe(409)
  })

  // Category names match exactly, as stored. A near-miss is not that category.
  it('answers 400 for a category in the wrong case, and writes nothing', async () => {
    const calls = makeSupabase({ row: ROW })
    const res = await post({ transactionId: 'txn-1', category: 'grocery' })
    expect(res.status).toBe(400)
    expect(calls.updates).toHaveLength(0)
  })

  // Spec §6.1 step 7: so a mistaken pick can be recovered from the logs.
  it('logs the previous and new category', async () => {
    makeSupabase({ row: { ...ROW, user_category: 'Food & Drink' } })
    await post({ transactionId: 'txn-1', category: 'Grocery' })
    expect(logs).toContainEqual(['[categorize] changed', { id: 'txn-1', from: 'Food & Drink', to: 'Grocery' }])
  })

  // The change log is the record of what was written; a write that did not happen must not be in it.
  it.each([
    ['a write that matched no rows', { error: null, count: 0 }],
    ['a failed write', { error: { message: 'boom' }, count: null }],
  ])('logs no change for %s', async (_, update) => {
    makeSupabase({ row: ROW, update })
    await post({ transactionId: 'txn-1', category: 'Grocery' })
    expect(logs.some((l) => l[0] === '[categorize] changed')).toBe(false)
  })
})

// #28 spec §6.1 step 8. A pick on a merchant with no rule teaches a household rule; a failed learn
// never fails the pick, which is already saved.
describe('POST /api/transactions/categorize: learning', () => {
  const pick = (category = 'Grocery') => post({ transactionId: 'txn-1', category })

  it('creates the rule with the exact payload and options', async () => {
    const calls = makeSupabase({ row: ROW })
    const res = await pick()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, learned: 'created' })
    expect(calls.upserts).toEqual([{
      payload: { household_id: 'hh-1', merchant_key: 'safeway', merchant_label: 'Safeway', category_id: 'c2', origin: 'learned' },
      options: { onConflict: 'household_id,merchant_key', ignoreDuplicates: true },
      select: 'id',
    }])
    expect(logs).toContainEqual(['[categorize] learned', { merchant_key: 'safeway', category: 'Grocery', rule: 'r-new' }])
  })

  it('learns from a padded merchant name with a trimmed label', async () => {
    const calls = makeSupabase({ row: { ...ROW, merchant_name: '  SAFEWAY ' } })
    await pick()
    expect(calls.upserts[0].payload).toMatchObject({ merchant_key: 'safeway', merchant_label: 'SAFEWAY' })
  })

  it('learns from a re-pick on an already-picked row', async () => {
    const calls = makeSupabase({ row: { ...ROW, user_category: 'Food & Drink' } })
    expect(await (await pick()).json()).toEqual({ ok: true, learned: 'created' })
    expect(calls.upserts).toHaveLength(1)
  })

  it('answers exists, with the pick saved, when the merchant already has a rule', async () => {
    const calls = makeSupabase({ row: ROW, upsert: { data: [], error: null } })
    const res = await pick()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, learned: 'exists' })
    expect(calls.updates).toHaveLength(1)
    expect(logs).toContainEqual(['[categorize] learn: rule exists', { merchant_key: 'safeway' }])
    expect(logs.some((l) => l[0] === '[categorize] learned')).toBe(false)
  })

  // The kind gate is built from the household's WHOLE list: from the picked category alone, the
  // row's TRANSFER_OUT primary would map to nothing and show as Uncategorized (spending), and a
  // transfer pick would be refused.
  it('learns a transfer pick on a TRANSFER_OUT row, gated on the whole category list', async () => {
    const calls = makeSupabase({
      row: { ...ROW, pfc_primary: 'TRANSFER_OUT', pfc_detailed: 'TRANSFER_OUT_ACCOUNT_TRANSFER' },
      categories: [
        { id: 'c1', name: 'Food & Drink', pfc_primary: 'FOOD_AND_DRINK', sort_order: 1 },
        { id: 'c2', name: 'Grocery', pfc_primary: null, sort_order: 2 },
        { id: 'c4', name: 'Transfer In', pfc_primary: 'TRANSFER_IN', sort_order: 4 },
        { id: 'c5', name: 'Transfer Out', pfc_primary: 'TRANSFER_OUT', sort_order: 5 },
      ],
    })
    expect(await (await pick('Transfer In')).json()).toEqual({ ok: true, learned: 'created' })
    expect(calls.upserts).toHaveLength(1)
    expect(calls.upserts[0].payload).toMatchObject({ category_id: 'c4' })
  })

  it.each([
    ['a pick across the line', ROW, 'Income'],
    ['a row with no merchant name', { ...ROW, merchant_name: null }, 'Grocery'],
    ['a pick equal to the bank category', ROW, 'Food & Drink'],
  ])('learns nothing from %s', async (_, row, category) => {
    const calls = makeSupabase({
      row,
      categories: [
        { id: 'c1', name: 'Food & Drink', pfc_primary: 'FOOD_AND_DRINK', sort_order: 1 },
        { id: 'c2', name: 'Grocery', pfc_primary: null, sort_order: 2 },
        { id: 'c3', name: 'Income', pfc_primary: 'INCOME', sort_order: 3 },
      ],
    })
    const res = await pick(category)
    expect(await res.json()).toEqual({ ok: true, learned: 'no' })
    expect(calls.upserts).toHaveLength(0)
    expect(assertEnvMatchesDatabase).not.toHaveBeenCalled()
  })

  it('learns nothing from a TRANSFER_OUT row after "Transfer Out" is deleted', async () => {
    const calls = makeSupabase({
      row: { ...ROW, pfc_primary: 'TRANSFER_OUT', pfc_detailed: 'TRANSFER_OUT_ACCOUNT_TRANSFER' },
      categories: [
        { id: 'c1', name: 'Food & Drink', pfc_primary: 'FOOD_AND_DRINK', sort_order: 1 },
        { id: 'c2', name: 'Grocery', pfc_primary: null, sort_order: 2 },
        { id: 'c4', name: 'Transfer In', pfc_primary: 'TRANSFER_IN', sort_order: 4 },
      ],
    })
    expect(await (await pick('Grocery')).json()).toEqual({ ok: true, learned: 'no' })
    expect(await (await pick('Transfer In')).json()).toEqual({ ok: true, learned: 'no' })
    expect(calls.upserts).toHaveLength(0)
  })

  it('answers 400 on a card payment, with no upsert', async () => {
    const calls = makeSupabase({ row: { ...ROW, pfc_primary: 'LOAN_PAYMENTS', pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' } })
    expect((await pick()).status).toBe(400)
    expect(calls.upserts).toHaveLength(0)
  })

  it.each([
    ['a failed write', { error: { message: 'boom' }, count: null }],
    ['a write that matched no rows', { error: null, count: 0 }],
  ])('learns nothing after %s', async (_, update) => {
    const calls = makeSupabase({ row: ROW, update })
    await pick()
    expect(calls.upserts).toHaveLength(0)
    expect(assertEnvMatchesDatabase).not.toHaveBeenCalled()
  })

  it('answers 200 failed, with the pick saved, when the insert errors', async () => {
    const calls = makeSupabase({ row: ROW, upsert: { data: null, error: { code: '23503', message: 'fk violation' } } })
    const res = await pick()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, learned: 'failed' })
    expect(calls.updates).toHaveLength(1)
    expect(logs).toContainEqual(['[categorize] learn failed', {
      household_id: 'hh-1', merchant_key: 'safeway', code: '23503', message: 'fk violation', details: undefined,
    }])
    expect(JSON.stringify(await (await pick()).json())).not.toContain('fk violation')
  })

  it('a thrown insert still answers 200 failed', async () => {
    makeSupabase({ row: ROW, upsert: 'throw' })
    const res = await pick()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, learned: 'failed' })
    expect(logs.some((l) => l[0] === '[categorize] learn failed')).toBe(true)
  })

  it('answers 200 skipped on an environment mismatch, with no insert', async () => {
    assertEnvMatchesDatabase.mockRejectedValueOnce(new EnvMismatchError('sandbox', 'production'))
    const calls = makeSupabase({ row: ROW })
    const res = await pick()
    expect(await res.json()).toEqual({ ok: true, learned: 'skipped' })
    expect(calls.updates).toHaveLength(1)
    expect(calls.upserts).toHaveLength(0)
    expect(logs.some((l) => l[0] === '[categorize] learn skipped: environment')).toBe(true)
  })

  it('answers 200 failed when the environment cannot be read, with no insert', async () => {
    assertEnvMatchesDatabase.mockRejectedValueOnce(new Error('could not read app_env: timeout'))
    const calls = makeSupabase({ row: ROW })
    const res = await pick()
    expect(await res.json()).toEqual({ ok: true, learned: 'failed' })
    expect(calls.updates).toHaveLength(1)
    expect(calls.upserts).toHaveLength(0)
    expect(logs.some((l) => l[0] === '[categorize] learn failed')).toBe(true)
  })

  it('a gate that throws still answers 200 failed, with the pick saved', async () => {
    learnableRule.mockImplementationOnce(() => { throw new Error('boom') })
    const calls = makeSupabase({ row: ROW })
    const res = await pick()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, learned: 'failed' })
    expect(calls.updates).toHaveLength(1)
    expect(calls.upserts).toHaveLength(0)
    expect(logs.some((l) => l[0] === '[categorize] learn failed')).toBe(true)
  })
})
