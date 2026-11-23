import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// lib/access.ts: who gets in at sign-in. It never deletes an account over a read it can't make, so a
// passing failure never removes a real one. When the membership read fails, it lets the person in
// unchecked, which nothing else records, so that's logged (#202). When the membership read found
// none but the invite couldn't be read or used, letting them in helps no one: they'd find no
// household. So they're asked to sign in again (#240).
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
          // Reachable only through .eq(), and run with every filter it was given, so a delete that
          // loses a filter shows in what inviteDelete is called with.
          delete: () => {
            const filters: Record<string, unknown> = {}
            const filtered = {
              eq: (column: string, value: unknown) => ((filters[column] = value), filtered),
              then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
                Promise.resolve(inviteDelete({ ...filters })).then(resolve, reject),
            }
            return { eq: filtered.eq }
          },
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
    expect(await ensureHouseholdAccess('user-1', 'member@example.com')).toBe('let-in')
    expect(logs).toEqual([])
  })

  // #248: an invite left behind, by a failed use or by an insert whose reply was lost, would add them
  // back if they were ever removed by hand. Only their own household's: another's is not theirs to clear.
  it("clears a member's leftover invite to their own household, by its lower-cased email", async () => {
    membership.mockResolvedValue({ data: [{ household_id: 'hh-1' }], error: null })
    expect(await ensureHouseholdAccess('user-1', 'Member@Example.com')).toBe('let-in')
    expect(inviteDelete).toHaveBeenCalledTimes(1)
    expect(inviteDelete).toHaveBeenCalledWith({ email: 'member@example.com', household_id: 'hh-1' })
    expect(invite).not.toHaveBeenCalled()
    expect(insert).not.toHaveBeenCalled()
    expect(deleteUser).not.toHaveBeenCalled()
  })

  it('lets a member in, and logs it, when clearing their leftover invite fails', async () => {
    membership.mockResolvedValue({ data: [{ household_id: 'hh-1' }], error: null })
    inviteDelete.mockResolvedValue({ error: NO_ANSWER })
    expect(await ensureHouseholdAccess('user-1', 'member@example.com')).toBe('let-in')
    expect(logs).toEqual([['[access] could not clear the used invite of a member', NO_ANSWER]])
  })

  it('lets in a member with no email, with no invite to clear', async () => {
    membership.mockResolvedValue({ data: [{ household_id: 'hh-1' }], error: null })
    expect(await ensureHouseholdAccess('user-1', undefined)).toBe('let-in')
    expect(inviteDelete).not.toHaveBeenCalled()
    expect(logs).toEqual([])
  })

  // An existing member gets through a passing failure, and RLS still guards the data (#240 kept this).
  it('lets the sign-in through, deletes no one and logs why, when the membership read fails', async () => {
    membership.mockResolvedValue({ data: null, error: NO_ANSWER })
    expect(await ensureHouseholdAccess('user-1', 'new@example.com')).toBe('let-in')
    expect(deleteUser).not.toHaveBeenCalled()
    expect(invite).not.toHaveBeenCalled()
    expect(inviteDelete).not.toHaveBeenCalled()
    expect(logs).toEqual([['[access] could not read the membership, so let the sign-in through', NO_ANSWER]])
  })

  it('asks a non-member to sign in again, deletes no one and logs why, when the invite read fails (#240)', async () => {
    membership.mockResolvedValue({ data: [], error: null })
    invite.mockResolvedValue({ data: null, error: NO_ANSWER })
    expect(await ensureHouseholdAccess('user-1', 'new@example.com')).toBe('try-again')
    expect(deleteUser).not.toHaveBeenCalled()
    expect(insert).not.toHaveBeenCalled()
    expect(logs).toEqual([['[access] could not read the invite, so ask them to sign in again', NO_ANSWER]])
  })

  it('adds an invited first-timer to the household and uses up the invite', async () => {
    membership.mockResolvedValue({ data: [], error: null })
    invite.mockResolvedValue({ data: { household_id: 'hh-1' }, error: null })
    expect(await ensureHouseholdAccess('user-2', 'New@Example.com')).toBe('let-in')
    expect(insert).toHaveBeenCalledWith({ user_id: 'user-2', household_id: 'hh-1' })
    expect(inviteDelete).toHaveBeenCalledWith({ email: 'new@example.com' })
    expect(logs).toEqual([])
  })

  it('asks an invited first-timer to sign in again, keeping the invite and the account, when adding them fails (#240)', async () => {
    membership.mockResolvedValue({ data: [], error: null })
    invite.mockResolvedValue({ data: { household_id: 'hh-1' }, error: null })
    insert.mockResolvedValue({ error: NO_ANSWER })
    expect(await ensureHouseholdAccess('user-2', 'new@example.com')).toBe('try-again')
    expect(inviteDelete).not.toHaveBeenCalled()
    expect(deleteUser).not.toHaveBeenCalled()
    expect(logs).toEqual([['[access] could not add the invited person to the household, so ask them to sign in again', NO_ANSWER]])
  })

  // Two first sign-ins at once: the other has just made the membership, so this one is a member too.
  it('lets in an invited first-timer whose membership a second sign-in has just made, and uses up the invite', async () => {
    membership.mockResolvedValue({ data: [], error: null })
    invite.mockResolvedValue({ data: { household_id: 'hh-1' }, error: null })
    insert.mockResolvedValue({ error: { code: '23505', message: 'duplicate key value violates unique constraint "memberships_pkey"' } })
    expect(await ensureHouseholdAccess('user-2', 'new@example.com')).toBe('let-in')
    expect(inviteDelete).toHaveBeenCalledWith({ email: 'new@example.com' })
    expect(deleteUser).not.toHaveBeenCalled()
    expect(logs).toEqual([])
  })

  // Left behind, the invite would add them back if they were ever removed by hand (#248).
  it('lets in someone just added to the household, and logs it, when using up their invite fails', async () => {
    membership.mockResolvedValue({ data: [], error: null })
    invite.mockResolvedValue({ data: { household_id: 'hh-1' }, error: null })
    inviteDelete.mockResolvedValue({ error: NO_ANSWER })
    expect(await ensureHouseholdAccess('user-2', 'new@example.com')).toBe('let-in')
    expect(logs).toEqual([['[access] could not use up the invite of someone now in the household', NO_ANSWER]])
  })

  it('removes an account that is neither a member nor invited', async () => {
    membership.mockResolvedValue({ data: [], error: null })
    invite.mockResolvedValue({ data: null, error: null })
    expect(await ensureHouseholdAccess('user-3', 'stranger@example.com')).toBe('not-invited')
    expect(deleteUser).toHaveBeenCalledWith('user-3')
    expect(logs).toEqual([])
  })

  // #249: the account is left, so the email form (which won't create one) can now send it links. Still
  // not invited, so the answer stands; the route signs the session out.
  it('still answers not invited, and logs it, when removing the account fails', async () => {
    membership.mockResolvedValue({ data: [], error: null })
    invite.mockResolvedValue({ data: null, error: null })
    deleteUser.mockResolvedValue({ data: null, error: { status: 500, code: 'unexpected_failure', message: 'Database error deleting user', name: 'AuthApiError' } })
    expect(await ensureHouseholdAccess('user-3', 'stranger@example.com')).toBe('not-invited')
    expect(logs).toEqual([
      ['[access] could not remove the uninvited account', { status: 500, code: 'unexpected_failure', message: 'Database error deleting user' }],
    ])
  })

  it('removes an account with no email, which no invite can name', async () => {
    membership.mockResolvedValue({ data: [], error: null })
    expect(await ensureHouseholdAccess('user-4', undefined)).toBe('not-invited')
    expect(invite).not.toHaveBeenCalled()
    expect(deleteUser).toHaveBeenCalledWith('user-4')
  })
})
