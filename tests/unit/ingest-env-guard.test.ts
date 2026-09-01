import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: {} }))

// vi.hoisted (not plain `const x = vi.fn()`) because static imports evaluate before this file's
// own body: `import ... from '@/lib/ingest'` below pulls in the mocked '@/lib/plaid' factory
// during module linking, which runs before a plain top-level const would have initialized --
// a bare `const accountsGet = vi.fn()` referenced in the factory throws
// "Cannot access 'accountsGet' before initialization". vi.hoisted lifts the fn identities
// above the mocks so the factories can close over them safely.
const { accountsGet } = vi.hoisted(() => ({ accountsGet: vi.fn() }))
vi.mock('@/lib/plaid', () => ({
  plaidEnv: 'sandbox',
  plaidClient: { accountsGet },
}))

const { syncItem } = vi.hoisted(() => ({ syncItem: vi.fn() }))
vi.mock('@/lib/sync', () => ({ syncItem }))

const { assertEnvMatchesDatabase } = vi.hoisted(() => ({ assertEnvMatchesDatabase: vi.fn() }))
vi.mock('@/lib/app-env', () => ({ assertEnvMatchesDatabase }))

import { storeAccounts, syncAndStore } from '@/lib/ingest'

describe('ingest environment guard', () => {
  beforeEach(() => {
    accountsGet.mockReset()
    syncItem.mockReset()
    assertEnvMatchesDatabase.mockReset()
  })

  it('storeAccounts refuses, and calls Plaid not at all, on a mismatch', async () => {
    assertEnvMatchesDatabase.mockRejectedValue(new Error('wrong environment'))
    await expect(storeAccounts('hh-1', 'item-1', 'access-token')).rejects.toThrow('wrong environment')
    expect(accountsGet).not.toHaveBeenCalled()
  })

  it('syncAndStore refuses, and syncs not at all, on a mismatch', async () => {
    assertEnvMatchesDatabase.mockRejectedValue(new Error('wrong environment'))
    await expect(
      syncAndStore({ id: 'item-1', household_id: 'hh-1', access_token: 'access-token' })
    ).rejects.toThrow('wrong environment')
    expect(syncItem).not.toHaveBeenCalled()
  })

  it('storeAccounts proceeds to Plaid when the environments match', async () => {
    assertEnvMatchesDatabase.mockResolvedValue(undefined)
    accountsGet.mockResolvedValue({ data: { accounts: [] } })
    await storeAccounts('hh-1', 'item-1', 'access-token')
    expect(accountsGet).toHaveBeenCalledOnce()
  })
})
