import { describe, it, expect, vi, beforeEach } from 'vitest'

// vi.hoisted for the same reason as tests/unit/ingest-env-guard.test.ts: the static route import
// below is linked before this file's body runs, firing every mock factory, so a factory closing
// over a plain top-level const throws "Cannot access 'x' before initialization".
const {
  insert,
  insertSingle,
  itemPublicTokenExchange,
  itemRemove,
  getUser,
  assertEnvMatchesDatabase,
  storeAccounts,
  syncAndStore,
} = vi.hoisted(() => ({
  insert: vi.fn(),
  insertSingle: vi.fn(),
  itemPublicTokenExchange: vi.fn(),
  itemRemove: vi.fn(),
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
  plaidClient: { itemPublicTokenExchange, itemRemove },
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
    itemRemove.mockReset()
    assertEnvMatchesDatabase.mockReset()
    storeAccounts.mockReset()
    syncAndStore.mockReset()
    getUser.mockResolvedValue({ data: { user: { id: 'user-1' } } })
    insert.mockReturnValue({ select: () => ({ single: insertSingle }) })
    insertSingle.mockResolvedValue({ data: { id: 'item-row-1' }, error: null })
    itemPublicTokenExchange.mockResolvedValue({
      data: { access_token: 'access-sandbox-1', item_id: 'item-1' },
    })
    itemRemove.mockResolvedValue({ data: { removed: true } })
    storeAccounts.mockResolvedValue(undefined)
    syncAndStore.mockResolvedValue({ added: 2, modified: 0, removed: 0 })
  })

  it('answers 409 when pointed at another environment’s database', async () => {
    assertEnvMatchesDatabase.mockRejectedValue(new EnvMismatchError('sandbox', 'production'))
    const res = await POST(linkRequest())
    expect(res.status).toBe(409)
  })

  it('creates no plaid_items row on a mismatch', async () => {
    assertEnvMatchesDatabase.mockRejectedValue(new EnvMismatchError('sandbox', 'production'))
    await POST(linkRequest())
    expect(insert).not.toHaveBeenCalled()
  })

  // THE POINT OF THE ORDERING. The Item already exists at Plaid — Link created it when the user
  // finished at their bank — so the guard runs AFTER the exchange, on purpose: refusing before it
  // would forfeit the only access token /item/remove could ever use and leave a live, un-revocable
  // authorization against a real bank login. Refusing after it costs the same spent slot and hands
  // back a token we can revoke. These assertions fail against the earlier before-the-exchange
  // ordering, where neither call happened at all.
  it('exchanges the token and revokes the Item at Plaid on a mismatch', async () => {
    assertEnvMatchesDatabase.mockRejectedValue(new EnvMismatchError('sandbox', 'production'))
    await POST(linkRequest())
    expect(itemPublicTokenExchange).toHaveBeenCalledOnce()
    expect(itemRemove).toHaveBeenCalledWith({ access_token: 'access-sandbox-1' })
  })

  it('answers 500, not 409, when app_env simply cannot be read', async () => {
    assertEnvMatchesDatabase.mockRejectedValue(new Error('could not read app_env: timeout'))
    const res = await POST(linkRequest())
    expect(res.status).toBe(500)
    expect(insert).not.toHaveBeenCalled()
  })

  it('revokes the Item at Plaid when app_env cannot be read either', async () => {
    assertEnvMatchesDatabase.mockRejectedValue(new Error('could not read app_env: timeout'))
    await POST(linkRequest())
    expect(itemRemove).toHaveBeenCalledWith({ access_token: 'access-sandbox-1' })
  })

  // A failed teardown must not become the user's answer, and must not throw out of the route:
  // they still need the 409, and the item id is logged so it can be removed by hand.
  it('still answers 409 when the revocation itself fails', async () => {
    assertEnvMatchesDatabase.mockRejectedValue(new EnvMismatchError('sandbox', 'production'))
    itemRemove.mockRejectedValue(new Error('plaid unreachable'))
    const res = await POST(linkRequest())
    expect(res.status).toBe(409)
    expect(insert).not.toHaveBeenCalled()
  })

  // The match case. Without it, a refactor that made the guard reject unconditionally would leave
  // this suite green on the one route where that means no bank can ever be connected.
  it('links normally when the environments match', async () => {
    assertEnvMatchesDatabase.mockResolvedValue(undefined)
    const res = await POST(linkRequest())
    expect(res.status).toBe(200)
    expect(itemPublicTokenExchange).toHaveBeenCalledOnce()
    expect(insert).toHaveBeenCalledOnce()
    expect(itemRemove).not.toHaveBeenCalled()
    expect(await res.json()).toMatchObject({ ok: true, added: 2 })
  })
})
