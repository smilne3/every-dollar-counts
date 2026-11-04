import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// lib/access.ts: who gets in at sign-in. It fails open on a read it can't make, so a passing blip never
// deletes a real account. That lets the person in unchecked, which nothing else records: an invited
// first-timer then finds no household until they sign in again. So each such read is logged (#202).
const { membership, invite, insert, inviteDelete, deleteUser } = vi.hoisted(() => ({
  membership: vi.fn(),
  invite: vi.fn(),
  insert: vi.fn(),
  inviteDelete: vi.fn(),
  deleteUser: vi.fn(),
}))

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === 'memberships') {
        return {
          select: () => ({ eq: () => ({ limit: () => membership() }) }),
          insert: (row: unknown) => insert(row),
        }
      }
      if (table === 'invites') {
        return {
          select: () => ({ eq: () => ({ maybeSingle: () => invite() }) }),
          delete: () => ({ eq: (_: string, email: string) => inviteDelete(email) }),
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
    auth: { admin: { deleteUser } },
  },
}))

import { ensureHouseholdAccess } from '@/lib/access'

const NO_ANSWER = { code: '', message: 'AbortError: Supabase gave no answer within 20 seconds' }

let logs: unknown[][]
beforeEach(() => {
  for (const fn of [membership, invite, insert, inviteDelete, deleteUser]) fn.mockReset()
  insert.mockResolvedValue({ error: null })
  inviteDelete.mockResolvedValue({ error: null })
  deleteUser.mockResolvedValue({ error: null })
  logs = []
  vi.spyOn(console, 'error').mockImplementation((...a) => void logs.push(a))
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('ensureHouseholdAccess', () => {
  it('lets a member in without logging anything', async () => {
    membership.mockResolvedValue({ data: [{ household_id: 'hh-1' }], error: null })
    expect(await ensureHouseholdAccess('user-1', 'member@example.com')).toBe(true)
    expect(logs).toEqual([])
  })

  it('lets the sign-in through, deletes no one and logs why, when the membership read fails', async () => {
    membership.mockResolvedValue({ data: null, error: NO_ANSWER })
    expect(await ensureHouseholdAccess('user-1', 'new@example.com')).toBe(true)
    expect(deleteUser).not.toHaveBeenCalled()
    expect(invite).not.toHaveBeenCalled()
    expect(logs).toEqual([['[access] could not read the membership, so let the sign-in through', NO_ANSWER]])
  })

  it('lets the sign-in through, deletes no one and logs why, when the invite read fails', async () => {
    membership.mockResolvedValue({ data: [], error: null })
    invite.mockResolvedValue({ data: null, error: NO_ANSWER })
    expect(await ensureHouseholdAccess('user-1', 'new@example.com')).toBe(true)
    expect(deleteUser).not.toHaveBeenCalled()
    expect(insert).not.toHaveBeenCalled()
    expect(logs).toEqual([['[access] could not read the invite, so let the sign-in through', NO_ANSWER]])
  })

  it('adds an invited first-timer to the household and uses up the invite', async () => {
    membership.mockResolvedValue({ data: [], error: null })
    invite.mockResolvedValue({ data: { household_id: 'hh-1' }, error: null })
    expect(await ensureHouseholdAccess('user-2', 'New@Example.com')).toBe(true)
    expect(insert).toHaveBeenCalledWith({ user_id: 'user-2', household_id: 'hh-1' })
    expect(inviteDelete).toHaveBeenCalledWith('new@example.com')
    expect(logs).toEqual([])
  })

  it('removes an account that is neither a member nor invited', async () => {
    membership.mockResolvedValue({ data: [], error: null })
    invite.mockResolvedValue({ data: null, error: null })
    expect(await ensureHouseholdAccess('user-3', 'stranger@example.com')).toBe(false)
    expect(deleteUser).toHaveBeenCalledWith('user-3')
  })
})
