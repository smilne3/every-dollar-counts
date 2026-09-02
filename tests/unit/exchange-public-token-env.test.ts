import { describe, it, expect, vi, beforeEach } from 'vitest'

// vi.hoisted for the same reason as tests/unit/ingest-env-guard.test.ts: the static route import
// below is linked before this file's body runs, firing every mock factory, so a factory closing
// over a plain top-level const throws "Cannot access 'x' before initialization".
const {
  insert,
  insertSingle,
  itemPublicTokenExchange,
  getUser,
  assertEnvMatchesDatabase,
  storeAccounts,
  syncAndStore,
} = vi.hoisted(() => ({
  insert: vi.fn(),
  insertSingle: vi.fn(),
  itemPublicTokenExchange: vi.fn(),
  getUser: vi.fn(),
  assertEnvMatchesDatabase: vi.fn(),
  storeAccounts: vi.fn(),
  syncAndStore: vi.fn(),
}))

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: { from: () => ({ insert }) },
}))
vi.mock('@/lib/plaid', () => ({
  plaidEnv: 'sandbox',
  plaidClient: { itemPublicTokenExchange },
}))
// The guard sits AFTER the auth and household checks, so those have to succeed for the test to
// reach it. Same client shape as tests/unit/manual-assets-env.test.ts.
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser },
    from: () => ({
      select: () => ({
        limit: () => ({ single: async () => ({ data: { household_id: 'hh-1' } }) }),
      }),
    }),
  }),
}))
vi.mock('@/lib/crypto', () => ({ encrypt: (s: string) => s }))
vi.mock('@/lib/ingest', () => ({ storeAccounts, syncAndStore }))

// Keep the real EnvMismatchError so the route's `instanceof` branch is exercised for real; replace
// only the assertion the test drives.
vi.mock('@/lib/app-env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/app-env')>()),
  assertEnvMatchesDatabase,
}))

import { EnvMismatchError } from '@/lib/app-env'

import { POST } from '@/app/api/plaid/exchange-public-token/route'

function linkRequest() {
  return new Request('http://localhost/api/plaid/exchange-public-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ public_token: 'public-sandbox-1', institution_name: 'Test Bank' }),
  })
}

describe('POST /api/plaid/exchange-public-token environment guard', () => {
  beforeEach(() => {
    insert.mockReset()
    insertSingle.mockReset()
    itemPublicTokenExchange.mockReset()
    assertEnvMatchesDatabase.mockReset()
    storeAccounts.mockReset()
    syncAndStore.mockReset()
    getUser.mockResolvedValue({ data: { user: { id: 'user-1' } } })
    insert.mockReturnValue({ select: () => ({ single: insertSingle }) })
    insertSingle.mockResolvedValue({ data: { id: 'item-row-1' }, error: null })
    itemPublicTokenExchange.mockResolvedValue({
      data: { access_token: 'access-sandbox-1', item_id: 'item-1' },
    })
    storeAccounts.mockResolvedValue(undefined)
    syncAndStore.mockResolvedValue({ added: 2, modified: 0, removed: 0 })
  })

  it('answers 409 when pointed at another environment’s database', async () => {
    assertEnvMatchesDatabase.mockRejectedValue(new EnvMismatchError('sandbox', 'production'))
    const res = await POST(linkRequest())
    expect(res.status).toBe(409)
  })

  it('creates no plaid_items row and exchanges no token on a mismatch', async () => {
    assertEnvMatchesDatabase.mockRejectedValue(new EnvMismatchError('sandbox', 'production'))
    await POST(linkRequest())
    expect(insert).not.toHaveBeenCalled()
    expect(itemPublicTokenExchange).not.toHaveBeenCalled()
  })

  it('answers 500, not 409, when app_env simply cannot be read', async () => {
    assertEnvMatchesDatabase.mockRejectedValue(new Error('could not read app_env: timeout'))
    const res = await POST(linkRequest())
    expect(res.status).toBe(500)
    expect(insert).not.toHaveBeenCalled()
    // NOTE what refusing here does and does not buy. The Item already exists at Plaid — Link
    // created it when the user finished at their bank — so declining the exchange does not save
    // the slot; it forfeits the access token that /item/remove would have needed. The guard that
    // actually prevents the cost runs in create-link-token, before Link opens; see
    // tests/unit/create-link-token-env.test.ts.
    expect(itemPublicTokenExchange).not.toHaveBeenCalled()
  })

  // The match case. Without it, a refactor that made the guard reject unconditionally would leave
  // this suite green on the one route where that means no bank can ever be connected.
  it('links normally when the environments match', async () => {
    assertEnvMatchesDatabase.mockResolvedValue(undefined)
    const res = await POST(linkRequest())
    expect(res.status).toBe(200)
    expect(itemPublicTokenExchange).toHaveBeenCalledOnce()
    expect(insert).toHaveBeenCalledOnce()
    expect(await res.json()).toMatchObject({ ok: true, added: 2 })
  })
})
