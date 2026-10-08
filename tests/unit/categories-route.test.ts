import { describe, it, expect, vi, beforeEach } from 'vitest'

// #28 spec §6.3: deleting a category now deletes its rules through the FK, in the database every
// environment shares. So DELETE is environment-guarded, before ANY read or write.
const { calls, getUser, assertEnvMatchesDatabase } = vi.hoisted(() => ({
  calls: [] as string[],
  getUser: vi.fn(),
  assertEnvMatchesDatabase: vi.fn(),
}))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser },
    from: (table: string) => {
      calls.push(table)
      const chain: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'update', 'delete']) chain[m] = () => chain
      chain.single = async () => ({ data: { name: 'Grocery' }, error: null })
      chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve)
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

import { EnvMismatchError } from '@/lib/app-env'
import { DELETE } from '@/app/api/categories/route'

const del = () =>
  DELETE(new Request('http://localhost/api/categories', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'c-grocery' }) }))

beforeEach(() => {
  calls.length = 0
  getUser.mockResolvedValue({ data: { user: { id: 'u1' } } })
  assertEnvMatchesDatabase.mockReset().mockResolvedValue(undefined)
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
