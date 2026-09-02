import { describe, it, expect, vi, beforeEach } from 'vitest'

const selectResult = vi.fn()
const insertResult = vi.fn()

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => selectResult() }) }),
      insert: (row: unknown) => insertResult(row),
    }),
  },
}))

// vitest pins PLAID_ENV to 'sandbox', but the allowance only applies to production Items — so the
// production path has to be mocked in to be tested at all.
vi.mock('@/lib/plaid', () => ({ plaidEnv: 'production' }))

import { countSlotsUsed, recordSlotUsed, LIFETIME_SLOTS } from '@/lib/plaid-slots'

beforeEach(() => {
  selectResult.mockReset()
  insertResult.mockReset()
})

describe('countSlotsUsed', () => {
  it('reports what the ledger holds', async () => {
    selectResult.mockResolvedValue({ count: 6, error: null })
    expect(await countSlotsUsed('hh-1')).toBe(6)
  })

  // Migration 018 is applied by hand, so between deploy and apply the table does not exist. A
  // Settings page that merely wants to print a number must not fall over because of it — and it
  // must not print a wrong one either.
  it('returns null rather than a wrong number when the ledger cannot be read', async () => {
    selectResult.mockResolvedValue({ count: null, error: { message: 'relation does not exist' } })
    expect(await countSlotsUsed('hh-1')).toBeNull()
  })

  it('returns null when the count comes back empty', async () => {
    selectResult.mockResolvedValue({ count: null, error: null })
    expect(await countSlotsUsed('hh-1')).toBeNull()
  })

  it('states the documented allowance', () => {
    expect(LIFETIME_SLOTS).toBe(10)
  })
})

describe('recordSlotUsed', () => {
  it('writes the item and the environment that spent the slot', async () => {
    insertResult.mockResolvedValue({ error: null })
    await recordSlotUsed({ householdId: 'hh-1', itemId: 'item-1', institutionName: 'Capital One' })
    expect(insertResult).toHaveBeenCalledWith({
      household_id: 'hh-1',
      item_id: 'item-1',
      institution_name: 'Capital One',
      plaid_env: 'production',
    })
  })

  // Losing a bookkeeping row must never fail the link the user just completed — the cost of that is
  // an undercount, against a bank connection they cannot get back.
  it('does not throw when the ledger write fails', async () => {
    insertResult.mockResolvedValue({ error: { code: 'XX000', message: 'boom' } })
    await expect(
      recordSlotUsed({ householdId: 'hh-1', itemId: 'item-1', institutionName: null })
    ).resolves.toBeUndefined()
  })

  it('treats a duplicate item as the retry it is', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    insertResult.mockResolvedValue({ error: { code: '23505', message: 'duplicate key' } })
    await recordSlotUsed({ householdId: 'hh-1', itemId: 'item-1', institutionName: null })
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})
