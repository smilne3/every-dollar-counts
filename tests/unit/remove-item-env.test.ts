import { describe, it, expect, vi, beforeEach } from 'vitest'

// vi.hoisted for the same reason as tests/unit/exchange-public-token-env.test.ts: the static route
// import below is linked before this file's body runs, firing every mock factory, so a factory
// closing over a plain top-level const throws "Cannot access 'x' before initialization".
const { single, deleteEq, itemRemove, decrypt, getUser } = vi.hoisted(() => ({
  single: vi.fn(),
  deleteEq: vi.fn(),
  itemRemove: vi.fn(),
  decrypt: vi.fn(),
  getUser: vi.fn(),
}))

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({ eq: () => ({ single }) }),
      delete: () => ({ eq: deleteEq }),
    }),
  },
}))
vi.mock('@/lib/plaid', () => ({
  plaidEnv: 'sandbox',
  plaidClient: { itemRemove },
}))
vi.mock('@/lib/crypto', () => ({ decrypt }))
// The guard sits after the auth and household-ownership checks, so those have to succeed for the
// test to reach it. Same client shape as tests/unit/exchange-public-token-env.test.ts.
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

import { POST } from '@/app/api/plaid/remove-item/route'

function removeRequest() {
  return new Request('http://localhost/api/plaid/remove-item', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ itemId: 'item-1' }),
  })
}

function itemInEnv(plaid_env: string) {
  return {
    data: {
      id: 'item-1',
      household_id: 'hh-1',
      access_token_encrypted: 'cipher',
      plaid_env,
    },
  }
}

describe('POST /api/plaid/remove-item environment guard', () => {
  beforeEach(() => {
    single.mockReset()
    deleteEq.mockReset()
    itemRemove.mockReset()
    decrypt.mockReset()
    getUser.mockResolvedValue({ data: { user: { id: 'user-1' } } })
    deleteEq.mockResolvedValue({ error: null })
    itemRemove.mockResolvedValue({ data: {} })
    decrypt.mockReturnValue('access-token')
  })

  it('answers 409 for a bank linked in another environment', async () => {
    single.mockResolvedValue(itemInEnv('production'))
    const res = await POST(removeRequest())
    expect(res.status).toBe(409)
  })

  // The whole point of the guard. Without it the cross-environment itemRemove fails with
  // INVALID_ACCESS_TOKEN, isAlreadyRemoved() swallows that as "already gone", and the delete runs
  // anyway — cascading a real bank's accounts and transactions away.
  it('removes nothing at Plaid and deletes nothing on a mismatch', async () => {
    single.mockResolvedValue(itemInEnv('production'))
    await POST(removeRequest())
    expect(itemRemove).not.toHaveBeenCalled()
    expect(deleteEq).not.toHaveBeenCalled()
    // The guard sits before the decrypt, so the token is never even unwrapped.
    expect(decrypt).not.toHaveBeenCalled()
  })

  it('still disconnects a bank from its own environment', async () => {
    single.mockResolvedValue(itemInEnv('sandbox'))
    const res = await POST(removeRequest())
    expect(res.status).toBe(200)
    expect(itemRemove).toHaveBeenCalledOnce()
    expect(deleteEq).toHaveBeenCalledOnce()
  })
})
