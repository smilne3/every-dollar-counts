import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// #28 spec §6.3: deleting a category now deletes its rules through the FK, in the database every
// environment shares. So DELETE is environment-guarded, before ANY read or write.
//
// The stand-in answers every insert { error: null } unless a test gives it, by table and method, a
// reply of its own (`replies`), as the add's tests do for a database that never answered (#173).
// Each table holds one row, which a .maybeSingle() read finds and a list read finds in a list,
// unless a test gives that table's read an answer of its own (`reads`), as the #241 tests do. There
// is no .single(): it makes no row an error (PGRST116), the trap .maybeSingle() avoids (#172), so a
// read sent through it fails here. A rename or a delete is one call to a database function (#100),
// recorded in `rpcs` with its arguments, and answered as PostgREST answers a function that returns
// nothing, unless a test gives that function a reply of its own (`rpcReplies`). What the functions
// themselves do is db/migrations/023's, and is not tested here.
const { calls, replies, reads, inserted, rpcs, rpcReplies, getUser, assertEnvMatchesDatabase } = vi.hoisted(() => ({
  calls: [] as string[],
  replies: new Map<string, unknown>(),
  reads: new Map<string, unknown>(),
  inserted: [] as unknown[],
  rpcs: [] as { fn: string; args: unknown }[],
  rpcReplies: new Map<string, unknown>(),
  getUser: vi.fn(),
  assertEnvMatchesDatabase: vi.fn(),
}))
vi.mock('@/lib/supabase/server', () => {
  const ROW: Record<string, unknown> = { memberships: { household_id: 'hh-1' }, categories: { name: 'Grocery', sort_order: 3 } }
  return {
    createClient: async () => ({
      auth: { getUser },
      from: (table: string) => {
        calls.push(table)
        let write = ''
        const chain: Record<string, unknown> = {}
        for (const m of ['select', 'eq', 'limit', 'order']) chain[m] = () => chain
        chain.insert = (row: unknown) => {
          write = `${table}.insert`
          inserted.push(row)
          return chain
        }
        chain.maybeSingle = async () => reads.get(table) ?? { data: ROW[table] ?? null, error: null }
        chain.then = (resolve: (v: unknown) => unknown) =>
          Promise.resolve(
            write ? (replies.get(write) ?? { error: null }) : (reads.get(table) ?? { data: ROW[table] ? [ROW[table]] : [], error: null })
          ).then(resolve)
        return chain
      },
      rpc: async (fn: string, args: unknown) => {
        calls.push(`rpc:${fn}`)
        rpcs.push({ fn, args })
        return rpcReplies.get(fn) ?? { data: null, error: null, count: null, status: 204, statusText: 'No Content' }
      },
    }),
  }
})
vi.mock('@/lib/plaid', () => ({ plaidEnv: 'sandbox' }))
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: {} }))
vi.mock('@/lib/app-env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/app-env')>()),
  assertEnvMatchesDatabase,
}))

import { AuthApiError, AuthRetryableFetchError, AuthSessionMissingError } from '@supabase/supabase-js'
import { EnvMismatchError } from '@/lib/app-env'
import { DELETE, GET, PATCH, POST } from '@/app/api/categories/route'
import { GATEWAY_502, NO_ANSWER, REFUSED_5XX } from '../stubs/no-answer'
import { answerOf, UNKNOWN_ANSWER } from './helpers/route-answers'

const send = (handler: (req: Request) => Promise<Response>, method: string, body: unknown) =>
  handler(new Request('http://localhost/api/categories', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }))
const del = () => send(DELETE, 'DELETE', { id: 'c-grocery' })
const add = (name = 'Pets') => send(POST, 'POST', { name })
const rename = (name = 'Groceries') => send(PATCH, 'PATCH', { id: 'c-grocery', name })

// A refusal from PostgREST, as postgrest-js reads it: Postgres's code and words, and the status
// PostgREST gives that code.
const refusal = (code: string, message: string, status: number) => ({
  data: null,
  error: { code, message, details: null, hint: null },
  count: null,
  status,
  statusText: '',
})
const DUPLICATE = refusal('23505', 'duplicate key value violates unique constraint "categories_household_id_name_key"', 409)
// PostgREST answers any P0 code but P0001 with a 500. The code is what tells it from a lost reply.
const GONE = refusal('P0002', 'no category c-grocery to rename', 500)
// What PostgREST answers before 023 is applied, or before it has reloaded its schema cache.
const NO_FUNCTION = refusal('PGRST202', 'Could not find the function public.rename_category(category_id, new_name) in the schema cache', 404)

beforeEach(() => {
  calls.length = 0
  replies.clear()
  reads.clear()
  inserted.length = 0
  rpcs.length = 0
  rpcReplies.clear()
  getUser.mockResolvedValue({ data: { user: { id: 'u1' } }, error: null })
  assertEnvMatchesDatabase.mockReset().mockResolvedValue(undefined)
})

// #143: every handler answered 401 'unauthorized' when getUser found no user, including when
// Supabase Auth could not be asked, so an outage read as a signed-out person. getUser answers as
// supabase-js does: no user and the error, in auth-js's own classes.
describe('/api/categories sign-in', () => {
  const handlers = [
    ['GET', () => GET(), 'Your categories could not be loaded. Please try again.'],
    ['POST', () => add(), 'That could not be saved. Please try again.'],
    ['PATCH', () => rename(), 'That could not be saved. Please try again.'],
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
      expect(await res.json()).toEqual({ error: 'Your session ended. Sign in again.' })
      expect(calls).toEqual([])
      expect(assertEnvMatchesDatabase).not.toHaveBeenCalled()
    }
  })

  it.each([
    ['GET', () => GET(), 'categories'],
    ['POST', () => add(), 'memberships'],
    ['PATCH', () => rename(), 'rpc:rename_category'],
    ['DELETE', del, 'rpc:delete_category'],
  ] as const)('%s goes on to the database when signed in', async (_, send, first) => {
    const res = await send()
    expect(res.status).toBe(200)
    expect(calls[0]).toBe(first)
  })
})

// Local dev and Previews share production's database (#148). A delete takes the category's rules
// with it, a rename moves its picks and budgets, and all three change the catalogue fingerprint
// that hides stored Jev suggestions. So each is guarded, before any read.
describe('/api/categories environment guard', () => {
  const writes = [
    ['POST', 'added', () => add()],
    ['PATCH', 'renamed', () => rename()],
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

  it('checks no environment for GET, which writes nothing', async () => {
    expect((await GET()).status).toBe(200)
    expect(assertEnvMatchesDatabase).not.toHaveBeenCalled()
  })
})

// #100, #117, #243: a name the app already uses for something else is refused before anything is
// checked or written, in words CategoryManager shows as they stand.
describe('/api/categories: a name the app uses', () => {
  it.each([
    ['Uncategorized'],
    ['uncategorized'],
    ['Other'],
    ['OTHER'],
    ['None'],
    ['none'],
    ['constructor'],
    ['toString'],
    ['__proto__'],
  ])('POST and PATCH refuse %s with a 400, and touch nothing', async (name) => {
    for (const send of [() => add(`  ${name} `), () => rename(`  ${name} `)]) {
      calls.length = 0
      const res = await send()
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: `“${name}” is a name the app uses. Choose another.` })
      expect(calls).toEqual([])
      expect(inserted).toEqual([])
      expect(assertEnvMatchesDatabase).not.toHaveBeenCalled()
    }
  })

  it('adds and renames to a name that only contains one', async () => {
    expect((await add('Other kids')).status).toBe(200)
    expect((await rename('Constructor')).status).toBe(200)
    expect(rpcs).toEqual([{ fn: 'rename_category', args: { category_id: 'c-grocery', new_name: 'Constructor' } }])
  })
})

// #100: a rename moved the category's picks and budget in two more requests, whose errors were
// never read, and a delete read none of its three. Each is now one call to a function in the
// database (db/migrations/023), all or nothing, and the route answers from that call alone.
describe('PATCH and DELETE /api/categories: one call to the database', () => {
  it('renames through rename_category, with the id and the trimmed name', async () => {
    const res = await rename('  Food & Drink ')
    expect(await res.json()).toEqual({ ok: true })
    expect(calls).toEqual(['rpc:rename_category'])
    expect(rpcs).toEqual([{ fn: 'rename_category', args: { category_id: 'c-grocery', new_name: 'Food & Drink' } }])
  })

  it('deletes through delete_category, with the id', async () => {
    const res = await del()
    expect(await res.json()).toEqual({ ok: true })
    expect(calls).toEqual(['rpc:delete_category'])
    expect(rpcs).toEqual([{ fn: 'delete_category', args: { category_id: 'c-grocery' } }])
  })

  it.each([
    ['PATCH', 'rename_category', () => rename()],
    ['DELETE', 'delete_category', del],
  ] as const)('%s answers 404 in words for a category that is gone, and logs it', async (_, fn, send) => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    rpcReplies.set(fn, GONE)
    const res = await send()
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'That category no longer exists. Showing the latest.' })
    const what = fn === 'rename_category' ? 'rename the category' : 'delete the category'
    expect(spy.mock.calls).toEqual([[`[categories] could not ${what}`, { id: 'c-grocery', status: 500, code: 'P0002', message: GONE.error.message }]])
    spy.mockRestore()
  })

  it('PATCH answers 409 in words for a name another category has, not the database words (#246)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    rpcReplies.set('rename_category', DUPLICATE)
    const res = await rename()
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'That name is already a category.' })
    expect(spy.mock.calls).toEqual([['[categories] could not rename the category', { id: 'c-grocery', status: 409, code: '23505', message: DUPLICATE.error.message }]])
    spy.mockRestore()
  })

  // A call whose reply was lost may have run, all of it or none (#173). It's logged with its status,
  // so the log can tell a dropped connection (0) from a gateway's page, which has no code at all.
  it.each([
    ['PATCH', 'rename_category', () => rename(), 'rename the category', NO_ANSWER, ''],
    ['PATCH', 'rename_category', () => rename(), 'rename the category', GATEWAY_502, undefined],
    ['DELETE', 'delete_category', del, 'delete the category', NO_ANSWER, ''],
    ['DELETE', 'delete_category', del, 'delete the category', GATEWAY_502, undefined],
  ] as const)('%s answers that it may not have saved when the reply was lost, and logs it', async (_, fn, send, what, reply, code) => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    rpcReplies.set(fn, reply)
    expect(await answerOf(await send())).toEqual(UNKNOWN_ANSWER)
    expect(spy.mock.calls).toEqual([[`[categories] could not ${what}`, { id: 'c-grocery', status: reply.status, code, message: reply.error.message }]])
    spy.mockRestore()
  })

  // Any other refusal wrote nothing. It is logged with its code, and answered in words of the
  // handler's own, never the database's.
  it.each([
    ['PATCH', 'rename_category', () => rename(), 'rename the category', 'That could not be saved. Please try again.', REFUSED_5XX],
    ['PATCH', 'rename_category', () => rename(), 'rename the category', 'That could not be saved. Please try again.', NO_FUNCTION],
    ['DELETE', 'delete_category', del, 'delete the category', 'That category could not be deleted. Please try again.', REFUSED_5XX],
    ['DELETE', 'delete_category', del, 'delete the category', 'That category could not be deleted. Please try again.', NO_FUNCTION],
  ] as const)('%s answers 500 in words and logs a refusal: %s', async (_, fn, send, what, words, reply) => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    rpcReplies.set(fn, reply)
    const res = await send()
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: words })
    expect(spy.mock.calls).toEqual([[`[categories] could not ${what}`, { id: 'c-grocery', status: reply.status, code: reply.error.code, message: reply.error.message }]])
    spy.mockRestore()
  })
})

// #173: an add the database never answered may have landed, so the answer is that it may not have
// saved, not a 400 carrying the fetch error's words. #246: a refusal is answered in words.
describe('POST /api/categories: a write that fails', () => {
  it('answers that an add may not have saved, and logs it', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    replies.set('categories.insert', NO_ANSWER)
    expect(await answerOf(await add())).toEqual(UNKNOWN_ANSWER)
    expect(spy.mock.calls).toEqual([['[categories] could not add the category', { status: 0, code: '', message: NO_ANSWER.error.message }]])
    spy.mockRestore()
  })

  // The retry after a lost reply, when the first add had landed, comes here too.
  it('answers 409 in words for a name another category has, not the database words (#246)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    replies.set('categories.insert', DUPLICATE)
    const res = await add()
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'That name is already a category.' })
    expect(spy.mock.calls).toEqual([['[categories] could not add the category', { status: 409, code: '23505', message: DUPLICATE.error.message }]])
    spy.mockRestore()
  })

  it('answers 500 in words and logs any other refusal', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    replies.set('categories.insert', REFUSED_5XX)
    const res = await add()
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'That could not be saved. Please try again.' })
    expect(spy.mock.calls).toEqual([['[categories] could not add the category', { status: 500, code: REFUSED_5XX.error.code, message: REFUSED_5XX.error.message }]])
    spy.mockRestore()
  })
})

// A request missing what it needs is refused before anything is checked or written. CategoryManager
// never sends one.
describe('/api/categories: a request missing its id or name', () => {
  it.each([
    ['POST with no name', () => send(POST, 'POST', {}), 'name required'],
    ['POST with a blank name', () => send(POST, 'POST', { name: '   ' }), 'name required'],
    ['PATCH with no id', () => send(PATCH, 'PATCH', { name: 'Groceries' }), 'id and name required'],
    ['PATCH with a blank name', () => send(PATCH, 'PATCH', { id: 'c-grocery', name: ' ' }), 'id and name required'],
    ['DELETE with no id', () => send(DELETE, 'DELETE', {}), 'id required'],
  ] as const)('%s answers 400 and touches nothing', async (_, request, words) => {
    const res = await request()
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: words })
    expect(calls).toEqual([])
    expect(assertEnvMatchesDatabase).not.toHaveBeenCalled()
  })
})

// PostgREST finds a function by the names of the arguments it's sent, so a name that differs from
// the function's own answers PGRST202 to every rename or delete. These read the functions from 023,
// as the SQL editor runs them, and hold the route's calls to them.
describe('/api/categories and db/migrations/023: the same functions and argument names', () => {
  const sql = readFileSync(join(__dirname, '../../db/migrations/023_category_rename_delete.sql'), 'utf8')
  const params = (fn: string) => {
    const signature = new RegExp(`create or replace function public\\.${fn}\\(([^)]*)\\)`).exec(sql)
    if (!signature) throw new Error(`023 defines no ${fn}`)
    return signature[1].split(',').map((p) => p.trim().split(/\s+/)[0])
  }
  const body = (fn: string) => sql.slice(sql.indexOf(`function public.${fn}(`)).split('\n$$;')[0]

  it.each([
    ['rename_category', () => rename()],
    ['delete_category', del],
  ] as const)('calls %s with exactly its parameters, in order', async (fn, send) => {
    await send()
    expect(rpcs.map((r) => r.fn)).toEqual([fn])
    expect(Object.keys(rpcs[0].args as object)).toEqual(params(fn))
  })

  // What a concurrent rename or delete of the same category waits on. No test here can run two at
  // once, so this holds the lock in place.
  it.each(['rename_category', 'delete_category'])('%s locks the category row before writing', (fn) => {
    expect(body(fn)).toMatch(/where c\.id = \w+\.category_id\s+for update;/)
  })
})

// #241: these reads ignored their error. A failed membership read answered "unauthorized", and a
// failed read of the highest sort_order saved the new category at 1, near the top instead of last,
// and none was logged. Since #237 a read that hangs fails after 20 seconds, so a hung read reached
// these too. Each failed read now answers 500 in the handler's own words, logs which read it was,
// and nothing after it runs.
describe('/api/categories: a read that fails (#241)', () => {
  // What postgrest-js gives a read #237's time limit stopped: the abort's own words, its stack as the
  // details, and a hint. Only the code and the message are logged.
  const failed = {
    message: 'AbortError: Supabase gave no answer within 20 seconds',
    details: 'AbortError: Supabase gave no answer within 20 seconds\n    at Timeout._onTimeout (lib/supabase/read-deadline.ts)',
    hint: 'Request was aborted (timeout or manual cancellation)',
    code: '',
  }
  const logged = { code: failed.code, message: failed.message }
  const cases = [
    ['GET', 'categories', 'the categories', () => GET(), 'Your categories could not be loaded. Please try again.', ['categories']],
    ['POST', 'memberships', 'the household', () => add(), 'That could not be saved. Please try again.', ['memberships']],
    ['POST', 'categories', 'the highest sort_order', () => add(), 'That could not be saved. Please try again.', ['memberships', 'categories']],
  ] as const

  it.each(cases)('%s answers 500 in words when its %s read fails, logs it, and goes no further', async (_, table, what, send, words, touched) => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    reads.set(table, { data: null, error: failed })
    const res = await send()
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: words })
    expect(spy.mock.calls).toEqual([[`[categories] could not read ${what}`, logged]])
    expect(calls).toEqual(touched)
    expect(inserted).toEqual([])
    spy.mockRestore()
  })

  // An empty reply, which postgrest-js reads as no data and no error. The list reads take it for the
  // failed read it is, rather than an empty list: as one, the add saved the category at 1 (#241).
  it.each([
    ['GET', () => GET(), 'Your categories could not be loaded. Please try again.', 'the categories', ['categories']],
    ['POST', () => add(), 'That could not be saved. Please try again.', 'the highest sort_order', ['memberships', 'categories']],
  ] as const)('%s answers 500 and goes no further when its list read returns no data and no error', async (_, send, words, what, touched) => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    reads.set('categories', { data: null, error: null })
    const res = await send()
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: words })
    expect(spy.mock.calls).toEqual([[`[categories] could not read ${what}`, { code: undefined, message: 'read returned no data and no error' }]])
    expect(calls).toEqual(touched)
    expect(inserted).toEqual([])
    spy.mockRestore()
  })
})

// The same reads finding no row, which is not a failure.
describe('/api/categories: a read that finds no row', () => {
  it('POST answers 403 in words and adds nothing for an account with no household', async () => {
    reads.set('memberships', { data: null, error: null })
    const res = await add()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: "Your account isn't part of a household." })
    expect(calls).toEqual(['memberships'])
  })

  it('POST adds a category after the last one', async () => {
    expect((await add()).status).toBe(200)
    expect(inserted).toEqual([{ household_id: 'hh-1', name: 'Pets', pfc_primary: null, sort_order: 4 }])
  })

  it("POST adds a household's first category at 1", async () => {
    reads.set('categories', { data: [], error: null })
    expect((await add()).status).toBe(200)
    expect(inserted).toEqual([{ household_id: 'hh-1', name: 'Pets', pfc_primary: null, sort_order: 1 }])
  })

  it('GET lists the categories it read', async () => {
    const list = [{ id: 'c-food', name: 'Food & Drink', pfc_primary: 'FOOD_AND_DRINK', sort_order: 0 }]
    reads.set('categories', { data: list, error: null })
    expect(await (await GET()).json()).toEqual({ categories: list })
  })
})
