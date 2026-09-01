import { describe, it, expect, vi, beforeEach } from 'vitest'

// vi.hoisted for the same reason as tests/unit/ingest-env-guard.test.ts: the static route import
// below is linked before this file's body runs, firing every mock factory.
const { upsert, getUser, assertEnvMatchesDatabase } = vi.hoisted(() => ({
  upsert: vi.fn(),
  getUser: vi.fn(),
  assertEnvMatchesDatabase: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser },
    from: (table: string) =>
      table === 'memberships'
        ? {
            select: () => ({
              limit: () => ({ single: async () => ({ data: { household_id: 'hh-1' } }) }),
            }),
          }
        : { upsert },
  }),
}))

vi.mock('@/lib/plaid', () => ({ plaidEnv: 'sandbox' }))
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: {} }))

// Keep the real EnvMismatchError so the route's `instanceof` branch is exercised for real; replace
// only the assertion the test drives.
vi.mock('@/lib/app-env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/app-env')>()),
  assertEnvMatchesDatabase,
}))

import { EnvMismatchError } from '@/lib/app-env'
import { POST } from '@/app/api/manual-assets/route'

function saveRequest() {
  return new Request('http://localhost/api/manual-assets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: 750000 }),
  })
}

describe('POST /api/manual-assets environment guard', () => {
  beforeEach(() => {
    upsert.mockReset()
    assertEnvMatchesDatabase.mockReset()
    getUser.mockResolvedValue({ data: { user: { id: 'user-1' } } })
    upsert.mockResolvedValue({ error: null })
  })

  it('answers 409 and writes nothing on a mismatch', async () => {
    assertEnvMatchesDatabase.mockRejectedValue(new EnvMismatchError('sandbox', 'production'))
    const res = await POST(saveRequest())
    expect(res.status).toBe(409)
    expect(upsert).not.toHaveBeenCalled()
  })

  it('writes normally when the environments match', async () => {
    assertEnvMatchesDatabase.mockResolvedValue(undefined)
    const res = await POST(saveRequest())
    expect(res.status).toBe(200)
    expect(upsert).toHaveBeenCalledOnce()
  })
})
