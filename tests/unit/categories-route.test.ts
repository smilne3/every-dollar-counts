import { describe, it, expect, vi, beforeEach } from 'vitest'

// #28 spec §6.3: deleting a category now deletes its rules through the FK, in the database every
// environment shares. So DELETE is environment-guarded, before ANY read or write.
//
// The stand-in is permissive (#100 tracks making it strict): every chain resolves to { error: null }
// unless a test gives one write, by table and method, a reply of its own (`replies`), as the add and
// the rename's tests do for a database that never answered (#173).
const { calls, replies, getUser, assertEnvMatchesDatabase } = vi.hoisted(() => ({
  calls: [] as string[],
  replies: new Map<string, unknown>(),
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
      for (const m of ['insert', 'update', 'delete']) chain[m] = () => ((write = `${table}.${m}`), chain)
      chain.single = async () => ({ data: table === 'memberships' ? { household_id: 'hh-1' } : { name: 'Grocery', sort_order: 3 }, error: null })
      chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(replies.get(write) ?? { error: null }).then(resolve)
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

describe('DELETE /api/categories environment guard', () => {
  it('answers 409 on a mismatch and touches no table', async () => {
    assertEnvMatchesDatabase.mockRejectedValue(new EnvMismatchError('sandbox', 'production'))
    expect((await del()).status).toBe(409)
    expect(calls).toEqual([])
  })

  it('answers 500 when the environment cannot be read, and touches no table', async () => {
    assertEnvMatchesDatabase.mockRejectedValue(new Error('could not read app_env'))
    expect((await del()).status).toBe(500)
    expect(calls).toEqual([])
  })

  it('deletes as before once the guard passes', async () => {
    expect((await del()).status).toBe(200)
    expect(calls).toEqual(['categories', 'categories', 'transactions', 'budgets'])
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
