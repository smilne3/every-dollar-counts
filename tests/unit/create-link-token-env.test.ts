import { describe, it, expect, vi, beforeEach } from 'vitest'

// vi.hoisted for the same reason as tests/unit/exchange-public-token-env.test.ts: the static route
// import below is linked before this file's body runs, firing every mock factory, so a factory
// closing over a plain top-level const throws "Cannot access 'x' before initialization".
const { linkTokenCreate, itemSingle, getUser, decrypt, assertEnvMatchesDatabase } = vi.hoisted(
  () => ({
    linkTokenCreate: vi.fn(),
    itemSingle: vi.fn(),
    getUser: vi.fn(),
    decrypt: vi.fn(),
    assertEnvMatchesDatabase: vi.fn(),
  })
)

vi.mock('@/lib/plaid', () => ({ plaidEnv: 'sandbox', plaidClient: { linkTokenCreate } }))
vi.mock('@/lib/crypto', () => ({ decrypt }))
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: { from: () => ({ select: () => ({ eq: () => ({ single: itemSingle }) }) }) },
}))
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
// Keep the real EnvMismatchError so the route's 409/500 split is exercised for real; replace only
// the assertion the test drives.
vi.mock('@/lib/app-env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/app-env')>()),
  assertEnvMatchesDatabase,
}))

import { EnvMismatchError } from '@/lib/app-env'
import { POST } from '@/app/api/plaid/create-link-token/route'

function linkTokenRequest(body: Record<string, unknown>) {
  return new Request('http://localhost/api/plaid/create-link-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// This is the guard that costs nothing to trip. Completing Link is what creates the Item at Plaid
// and spends one of ten unrefundable slots, and it happens BEFORE exchange-public-token runs — so
// a refusal there can only decline the access token, leaving an Item nothing can ever remove.
// Refusing here means Link never opens and no Item is created.
describe('POST /api/plaid/create-link-token environment guard', () => {
  beforeEach(() => {
    linkTokenCreate.mockReset()
    itemSingle.mockReset()
    decrypt.mockReset()
    assertEnvMatchesDatabase.mockReset()
    getUser.mockResolvedValue({ data: { user: { id: 'user-1' } } })
    linkTokenCreate.mockResolvedValue({ data: { link_token: 'link-sandbox-1' } })
    decrypt.mockReturnValue('access-token')
  })

  it('answers 409 and issues no link token when the database is another environment’s', async () => {
    assertEnvMatchesDatabase.mockRejectedValue(new EnvMismatchError('sandbox', 'production'))
    const res = await POST(linkTokenRequest({ products: ['transactions'] }))
    expect(res.status).toBe(409)
    expect(linkTokenCreate).not.toHaveBeenCalled()
  })

  it('answers 500, not 409, when app_env simply cannot be read', async () => {
    assertEnvMatchesDatabase.mockRejectedValue(new Error('could not read app_env: timeout'))
    const res = await POST(linkTokenRequest({ products: ['transactions'] }))
    expect(res.status).toBe(500)
    expect(linkTokenCreate).not.toHaveBeenCalled()
  })

  it('issues a link token normally when the environments match', async () => {
    assertEnvMatchesDatabase.mockResolvedValue(undefined)
    const res = await POST(linkTokenRequest({ products: ['transactions'] }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ link_token: 'link-sandbox-1' })
  })

  // Update mode creates no Item and is already covered by the item's own plaid_env check, so it
  // must NOT be failed closed on an app_env blip — that would block reconnecting a real bank for
  // no gain. Reconnecting is the cheap fix; blocking it pushes the user toward a relink, and a
  // relink is what spends a slot.
  it('does not consult app_env in update mode', async () => {
    itemSingle.mockResolvedValue({
      data: { access_token_encrypted: 'cipher', household_id: 'hh-1', plaid_env: 'sandbox' },
    })
    const res = await POST(linkTokenRequest({ mode: 'update', itemId: 'item-1' }))
    expect(res.status).toBe(200)
    expect(assertEnvMatchesDatabase).not.toHaveBeenCalled()
    expect(linkTokenCreate).toHaveBeenCalledOnce()
  })
})
