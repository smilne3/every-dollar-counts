import { describe, it, expect, vi, beforeEach } from 'vitest'

// #28 spec §6.2. The stand-in is strict on purpose (a permissive one hid three dead guards here
// before, #99): each write resolves only after the filters the route must apply, and records the
// options it was called with, because stubs otherwise ignore `{ count: 'exact' }`.
const { db, getUser, assertEnvMatchesDatabase } = vi.hoisted(() => ({
  db: {
    membership: { data: { household_id: 'hh-1' }, error: null } as { data: unknown; error: unknown },
    rule: { data: { id: 'r1', category_id: 'c-grocery' }, error: null } as { data: unknown; error: unknown },
    categories: { data: [] as unknown[], error: null } as { data: unknown; error: unknown },
    write: { error: null, count: 1 } as { error: unknown; count: number | null },
    calls: [] as { table: string; op: string; args: unknown[] }[],
  },
  getUser: vi.fn(),
  assertEnvMatchesDatabase: vi.fn(),
}))

function builder(table: string) {
  const filters: string[] = []
  const record = (op: string, args: unknown[]) => db.calls.push({ table, op, args })
  const chain: Record<string, unknown> = {}
  chain.select = (...a: unknown[]) => (record('select', a), chain)
  chain.order = (...a: unknown[]) => (record('order', a), chain)
  chain.limit = () => chain
  chain.eq = (col: string, v: unknown) => {
    filters.push(`${col}=${v}`)
    record('eq', [col, v])
    return chain
  }
  chain.maybeSingle = async () => (table === 'memberships' ? db.membership : db.rule)
  chain.update = (...a: unknown[]) => (record('update', a), chain)
  chain.delete = (...a: unknown[]) => (record('delete', a), chain)
  chain.then = (resolve: (v: unknown) => unknown) => {
    const wrote = db.calls.some((c) => c.table === table && (c.op === 'update' || c.op === 'delete'))
    if (!wrote) return Promise.resolve(table === 'categories' ? db.categories : { data: [], error: null }).then(resolve)
    // A write resolves only when filtered on BOTH the rule id and the category it expected.
    const guarded = filters.includes('id=r1') && filters.some((f) => f.startsWith('category_id='))
    return Promise.resolve(guarded ? db.write : { error: null, count: 0 }).then(resolve)
  }
  return chain
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser }, from: (t: string) => builder(t) }),
}))
vi.mock('@/lib/plaid', () => ({ plaidEnv: 'sandbox' }))
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: {} }))
vi.mock('@/lib/app-env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/app-env')>()),
  assertEnvMatchesDatabase,
}))

import { EnvMismatchError } from '@/lib/app-env'
import { PATCH, DELETE } from '@/app/api/category-rules/route'

const CATS = [
  { id: 'c-food', name: 'Food & Drink', pfc_primary: 'FOOD_AND_DRINK', sort_order: 0 },
  { id: 'c-grocery', name: 'Grocery', pfc_primary: null, sort_order: 1 },
  { id: 'c-income', name: 'Income', pfc_primary: 'INCOME', sort_order: 2 },
]
const req = (method: string, body: unknown) =>
  new Request('http://localhost/api/category-rules', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
const change = (body: Record<string, unknown> = {}) => PATCH(req('PATCH', { id: 'r1', categoryId: 'c-food', expectedCategoryId: 'c-grocery', ...body }))
const remove = (body: Record<string, unknown> = {}) => DELETE(req('DELETE', { id: 'r1', expectedCategoryId: 'c-grocery', ...body }))
const writes = () => db.calls.filter((c) => c.op === 'update' || c.op === 'delete')
const error = async (res: Response) => (await res.json()).error

beforeEach(() => {
  db.membership = { data: { household_id: 'hh-1' }, error: null }
  db.rule = { data: { id: 'r1', category_id: 'c-grocery' }, error: null }
  db.categories = { data: CATS, error: null }
  db.write = { error: null, count: 1 }
  db.calls = []
  getUser.mockResolvedValue({ data: { user: { id: 'u1' } }, error: null })
  assertEnvMatchesDatabase.mockReset().mockResolvedValue(undefined)
})

describe('PATCH /api/category-rules (Change)', () => {
  it('moves a rule to a same-kind category, guarded on the category it expected', async () => {
    const res = await change()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    const [w] = writes()
    expect(w.args[0]).toMatchObject({ category_id: 'c-food' })
    expect(typeof (w.args[0] as { updated_at: unknown }).updated_at).toBe('string')
    expect(w.args[1]).toEqual({ count: 'exact' })
    expect(db.calls).toContainEqual({ table: 'category_rules', op: 'eq', args: ['category_id', 'c-grocery'] })
  })

  it('reads the categories of the caller\'s household, in order', async () => {
    await change()
    expect(db.calls).toContainEqual({ table: 'categories', op: 'eq', args: ['household_id', 'hh-1'] })
    expect(db.calls).toContainEqual({ table: 'categories', op: 'order', args: ['sort_order'] })
  })

  it('answers 200 without writing when the category is unchanged', async () => {
    const res = await change({ categoryId: 'c-grocery' })
    expect(res.status).toBe(200)
    expect(writes()).toHaveLength(0)
  })

  it('answers 404 for a missing rule and 409 for a stale expected category', async () => {
    db.rule = { data: null, error: null }
    expect((await change()).status).toBe(404)
    db.rule = { data: { id: 'r1', category_id: 'c-food' }, error: null }
    const res = await change()
    expect(res.status).toBe(409)
    expect(await error(res)).toBe('This rule just changed. Refresh and try again.')
    expect(writes()).toHaveLength(0)
  })

  it('answers 409 when the expected category was deleted between reads', async () => {
    db.categories = { data: CATS.filter((c) => c.id !== 'c-grocery'), error: null }
    expect((await change()).status).toBe(409)
  })

  it('refuses a cross-kind Change and an unknown target', async () => {
    const cross = await change({ categoryId: 'c-income' })
    expect(cross.status).toBe(400)
    expect(await error(cross)).toBe('A rule can only move to a category that counts the same way.')
    const unknown = await change({ categoryId: 'c-nope' })
    expect(unknown.status).toBe(400)
    expect(await error(unknown)).toBe('That category no longer exists. Refresh and try again.')
    expect(writes()).toHaveLength(0)
  })

  it('answers 409 on a zero count and on 23503, and 500 on any other write error, without database text', async () => {
    db.write = { error: null, count: 0 }
    expect((await change()).status).toBe(409)
    db.write = { error: { code: '23503', message: 'violates foreign key' }, count: null }
    expect((await change()).status).toBe(409)
    db.write = { error: { code: 'XX000', message: 'internal db words' }, count: null }
    const res = await change()
    expect(res.status).toBe(500)
    expect(await error(res)).toBe('That could not be saved. Please try again.')
  })

  it('answers 500 on a failed rule or categories read', async () => {
    db.rule = { data: null, error: { message: 'boom' } }
    expect((await change()).status).toBe(500)
    db.rule = { data: { id: 'r1', category_id: 'c-grocery' }, error: null }
    db.categories = { data: null, error: { message: 'boom' } }
    expect((await change()).status).toBe(500)
  })

  it('answers 400 on a malformed body without touching the database', async () => {
    expect((await PATCH(req('PATCH', '{not json'))).status).toBe(400)
    expect((await change({ categoryId: '' })).status).toBe(400)
    expect(db.calls).toHaveLength(0)
  })
})

describe('DELETE /api/category-rules (Remove)', () => {
  it('deletes guarded on the category it expected, with an exact count', async () => {
    const res = await remove()
    expect(res.status).toBe(200)
    const [w] = writes()
    expect(w.op).toBe('delete')
    expect(w.args[0]).toEqual({ count: 'exact' })
    expect(db.calls).toContainEqual({ table: 'category_rules', op: 'eq', args: ['category_id', 'c-grocery'] })
  })

  it('answers 409 on a zero count and 500 on an error', async () => {
    db.write = { error: null, count: 0 }
    expect((await remove()).status).toBe(409)
    db.write = { error: { message: 'boom' }, count: null }
    expect((await remove()).status).toBe(500)
  })
})

describe.each([
  ['PATCH', () => change()],
  ['DELETE', () => remove()],
])('%s guards', (_m, call) => {
  it('answers 401 signed out, 503 when auth is unreachable, and 403 without a household', async () => {
    getUser.mockResolvedValueOnce({ data: { user: null }, error: null })
    expect((await call()).status).toBe(401)
    const { AuthRetryableFetchError } = await import('@supabase/supabase-js')
    getUser.mockResolvedValueOnce({ data: { user: null }, error: new AuthRetryableFetchError('down', 0) })
    expect((await call()).status).toBe(503)
    db.membership = { data: null, error: null }
    const res = await call()
    expect(res.status).toBe(403)
    expect(await error(res)).toBe("Your account isn't part of a household.")
  })

  it("answers the environment guard's 409 and 500, and writes nothing", async () => {
    assertEnvMatchesDatabase.mockRejectedValueOnce(new EnvMismatchError('sandbox', 'production'))
    expect((await call()).status).toBe(409)
    assertEnvMatchesDatabase.mockRejectedValueOnce(new Error('could not read app_env'))
    expect((await call()).status).toBe(500)
    expect(writes()).toHaveLength(0)
    expect(db.calls.some((c) => c.table === 'category_rules')).toBe(false)
  })
})
