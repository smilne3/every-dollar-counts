import { describe, it, expect, vi, beforeEach } from 'vitest'

// #28 spec §6.3: deleting a category now deletes its rules through the FK, in the database every
// environment shares. So DELETE is environment-guarded, before ANY read or write.
//
// The stand-in is permissive (#100 tracks making it strict): every write resolves to { error: null }
// unless a test gives it, by table and method, a reply of its own (`replies`), as the add and the
// rename's tests do for a database that never answered (#173). A read finds a row, or for GET a
// list, unless a test gives that table's read an answer of its own (`reads`), as the failed-read
// tests do (#241). There is no .single(): it makes no row an error (PGRST116), the trap
// .maybeSingle() avoids (#172), so a read sent through it fails here.
const { calls, replies, reads, inserted, getUser, assertEnvMatchesDatabase } = vi.hoisted(() => ({
  calls: [] as string[],
  replies: new Map<string, unknown>(),
  reads: new Map<string, unknown>(),
  inserted: [] as unknown[],
  getUser: vi.fn(),
  assertEnvMatchesDatabase: vi.fn(),
}))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser },
    from: (table: string) => {
      calls.push(table)
      let write = ''
      const chain: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'limit', 'order']) chain[m] = () => chain
      for (const m of ['update', 'delete']) chain[m] = () => ((write = `${table}.${m}`), chain)
      chain.insert = (row: unknown) => {
        write = `${table}.insert`
        inserted.push(row)
        return chain
      }
      chain.maybeSingle = async () =>
        reads.get(table) ?? { data: table === 'memberships' ? { household_id: 'hh-1' } : { name: 'Grocery', sort_order: 3 }, error: null }
      chain.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve(write ? (replies.get(write) ?? { error: null }) : (reads.get(table) ?? { data: [], error: null })).then(resolve)
      return chain
    },
  }),
}))
vi.mock('@/lib/plaid', () => ({ plaidEnv: 'sandbox' }))
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: {} }))
vi.mock('@/lib/app-env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/app-env')>()),
  assertEnvMatchesDatabase,
}))

import { AuthApiError, AuthRetryableFetchError, AuthSessionMissingError } from '@supabase/supabase-js'
import { EnvMismatchError } from '@/lib/app-env'
import { DELETE, GET, PATCH, POST } from '@/app/api/categories/route'
import { NO_ANSWER, REFUSED_5XX } from '../stubs/no-answer'
import { answerOf, UNKNOWN_ANSWER } from './helpers/route-answers'

const send = (handler: (req: Request) => Promise<Response>, method: string, body: unknown) =>
  handler(new Request('http://localhost/api/categories', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }))
const del = () => send(DELETE, 'DELETE', { id: 'c-grocery' })
const add = () => send(POST, 'POST', { name: 'Pets' })
const rename = () => send(PATCH, 'PATCH', { id: 'c-grocery', name: 'Groceries' })

beforeEach(() => {
  calls.length = 0
  replies.clear()
  reads.clear()
  inserted.length = 0
  getUser.mockResolvedValue({ data: { user: { id: 'u1' } }, error: null })
  assertEnvMatchesDatabase.mockReset().mockResolvedValue(undefined)
})

// #143: every handler answered 401 'unauthorized' when getUser found no user, including when
// Supabase Auth could not be asked, so an outage read as a signed-out person. getUser answers as
// supabase-js does: no user and the error, in auth-js's own classes.
describe('/api/categories sign-in', () => {
  const handlers = [
    ['GET', () => GET(), 'Your categories could not be loaded. Please try again.'],
    ['POST', add, 'That could not be saved. Please try again.'],
    ['PATCH', rename, 'That could not be saved. Please try again.'],
    ['DELETE', del, 'That category could not be deleted. Please try again.'],
  ] as const

  it.each(handlers)('%s answers 503 in words, logs it, and touches nothing when Supabase Auth cannot be asked', async (_, send, words) => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    getUser.mockResolvedValue({ data: { user: null }, error: new AuthRetryableFetchError('fetch failed', 0) })
    const res = await send()
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: words })
    expect(logged).toHaveBeenCalledWith('[categories] auth check failed', { status: 0, message: 'fetch failed' })
    expect(calls).toEqual([])
    expect(assertEnvMatchesDatabase).not.toHaveBeenCalled()
    logged.mockRestore()
  })

  it.each(handlers)('%s answers 401 and touches nothing when the session has ended', async (_, send) => {
    for (const error of [
      new AuthSessionMissingError(),
      new AuthApiError('Invalid Refresh Token: Refresh Token Not Found', 400, 'refresh_token_not_found'),
    ]) {
      calls.length = 0
      getUser.mockResolvedValue({ data: { user: null }, error })
      const res = await send()
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ error: 'unauthorized' })
      expect(calls).toEqual([])
      expect(assertEnvMatchesDatabase).not.toHaveBeenCalled()
    }
  })

  it.each(handlers)('%s goes on to the database when signed in', async (method, send) => {
    const res = await send()
    expect(res.status).toBe(200)
    expect(calls[0]).toBe(method === 'POST' ? 'memberships' : 'categories')
  })
})

// Local dev and Previews share production's database (#148). A delete takes the category's rules
// with it, a rename moves its picks and budgets, and all three change the catalogue fingerprint
// that hides stored Jev suggestions. So each is guarded, before any read.
describe('/api/categories environment guard', () => {
  const writes = [
    ['POST', 'added', add],
    ['PATCH', 'renamed', rename],
    ['DELETE', 'deleted', del],
  ] as const

  it.each(writes)('%s answers 409 on a mismatch, says nothing was %s, and touches no table', async (_, nothing, send) => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    assertEnvMatchesDatabase.mockRejectedValue(new EnvMismatchError('sandbox', 'production'))
    const res = await send()
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: `This app is pointed at a database from a different environment. Nothing ${nothing}.` })
    expect(calls).toEqual([])
    logged.mockRestore()
  })

  it.each(writes)('%s answers 500 when the environment cannot be read, says nothing was %s, and touches no table', async (_, nothing, send) => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    assertEnvMatchesDatabase.mockRejectedValue(new Error('could not read app_env'))
    const res = await send()
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: `Could not verify which database this is, so nothing was ${nothing}.` })
    expect(calls).toEqual([])
    logged.mockRestore()
  })

  it.each(writes)('%s writes as before once the guard passes', async (_, __, send) => {
    expect((await send()).status).toBe(200)
    expect(assertEnvMatchesDatabase).toHaveBeenCalledOnce()
  })

  it('deletes as before once the guard passes', async () => {
    expect((await del()).status).toBe(200)
    expect(calls).toEqual(['categories', 'categories', 'transactions', 'budgets'])
  })

  it('checks no environment for GET, which writes nothing', async () => {
    expect((await GET()).status).toBe(200)
    expect(assertEnvMatchesDatabase).not.toHaveBeenCalled()
  })
})

// #173: an add or a rename the database never answered may have landed, so the answer is that it
// may not have saved, not a 400 carrying the fetch error's words. A refusal is answered as before.
describe('POST and PATCH /api/categories: a write the database never answered', () => {
  it('adds and renames as before when the database answers', async () => {
    expect(await (await add()).json()).toEqual({ ok: true })
    expect(await (await rename()).json()).toEqual({ ok: true })
  })

  it('answers that an add may not have saved', async () => {
    replies.set('categories.insert', NO_ANSWER)
    const res = await add()
    expect(await answerOf(res)).toEqual(UNKNOWN_ANSWER)
  })

  it('answers that a rename may not have saved, and moves no picks or budgets onto the new name', async () => {
    replies.set('categories.update', NO_ANSWER)
    const res = await rename()
    expect(await answerOf(res)).toEqual(UNKNOWN_ANSWER)
    expect(calls).toEqual(['categories', 'categories'])
  })

  // A refusal carries a code, whatever its status, and is answered as before: in JSON, a 400.
  const refusals = [
    ['a duplicate name, answered 409', { error: { code: '23505', message: 'duplicate key value violates unique constraint' }, status: 409 }],
    ['a statement timeout, answered 500', REFUSED_5XX],
  ] as const

  it.each(refusals)('still refuses an add the database refused: %s', async (_, reply) => {
    replies.set('categories.insert', reply)
    const res = await add()
    expect(res.status).toBe(400)
    expect(res.headers.get('content-type')).toContain('application/json')
  })

  it.each(refusals)('still refuses a rename the database refused, and moves no picks or budgets: %s', async (_, reply) => {
    replies.set('categories.update', reply)
    const res = await rename()
    expect(res.status).toBe(400)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(calls).toEqual(['categories', 'categories'])
  })
})

// #241: these reads ignored their error. A failed membership read answered "unauthorized", a failed
// category read "not found", and a failed read of the highest sort_order added the category at 1,
// at the top of the list, and none was logged. Since #237 a read that hangs fails after 20 seconds,
// so a hung read reached these too. Each failed read now answers 500 in the handler's own words, logs
// which read it was, and nothing after it runs.
describe('/api/categories: a read that fails (#241)', () => {
  const failed = { code: '', message: 'AbortError: Supabase gave no answer within 20 seconds' }
  const cases = [
    ['GET', 'categories', 'the categories', () => GET(), 'Your categories could not be loaded. Please try again.', ['categories']],
    ['POST', 'memberships', 'the household', add, 'That could not be saved. Please try again.', ['memberships']],
    ['POST', 'categories', 'the highest sort_order', add, 'That could not be saved. Please try again.', ['memberships', 'categories']],
    ['PATCH', 'categories', 'the category', rename, 'That could not be saved. Please try again.', ['categories']],
    ['DELETE', 'categories', 'the category', del, 'That category could not be deleted. Please try again.', ['categories']],
  ] as const

  it.each(cases)('%s answers 500 in words when its %s read fails, logs it, and goes no further', async (_, table, what, send, words, touched) => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    reads.set(table, { data: null, error: failed })
    const res = await send()
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: words })
    expect(logged).toHaveBeenCalledWith(`[categories] could not read ${what}`, failed)
    expect(calls).toEqual(touched)
    expect(inserted).toEqual([])
    logged.mockRestore()
  })
})

// The same reads finding no row, which is not a failure: each answers as it did before #241.
describe('/api/categories: a read that finds no row', () => {
  it('POST answers 401 and adds nothing for an account with no household', async () => {
    reads.set('memberships', { data: null, error: null })
    const res = await add()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorized' })
    expect(calls).toEqual(['memberships'])
  })

  it('POST adds a category after the last one', async () => {
    expect((await add()).status).toBe(200)
    expect(inserted).toEqual([{ household_id: 'hh-1', name: 'Pets', pfc_primary: null, sort_order: 4 }])
  })

  it("POST adds a household's first category at 1", async () => {
    reads.set('categories', { data: null, error: null })
    expect((await add()).status).toBe(200)
    expect(inserted).toEqual([{ household_id: 'hh-1', name: 'Pets', pfc_primary: null, sort_order: 1 }])
  })

  it.each([
    ['PATCH', rename],
    ['DELETE', del],
  ] as const)('%s answers 404 and writes nothing for a category that is gone', async (_, send) => {
    reads.set('categories', { data: null, error: null })
    const res = await send()
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not found' })
    expect(calls).toEqual(['categories'])
  })

  it('GET lists the categories it read', async () => {
    const list = [{ id: 'c-food', name: 'Food & Drink', pfc_primary: 'FOOD_AND_DRINK', sort_order: 0 }]
    reads.set('categories', { data: list, error: null })
    expect(await (await GET()).json()).toEqual({ categories: list })
  })
})
