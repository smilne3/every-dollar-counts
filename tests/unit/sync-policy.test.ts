import { describe, it, expect } from 'vitest'
import { shouldSyncTransactions } from '@/lib/sync-policy'

describe('shouldSyncTransactions', () => {
  it('syncs a healthy transactions item', () => {
    expect(shouldSyncTransactions({ products: ['transactions'], status: 'ok' })).toBe(true)
  })
  it('does not sync an investment-only item (balances only)', () => {
    expect(shouldSyncTransactions({ products: ['investments'], status: 'ok' })).toBe(false)
  })
  it('does not sync a loan-only item (balances only)', () => {
    expect(shouldSyncTransactions({ products: ['liabilities'], status: 'ok' })).toBe(false)
  })
  it('does not sync an item that needs reconnection', () => {
    expect(shouldSyncTransactions({ products: ['transactions'], status: 'needs_reconnect' })).toBe(
      false
    )
  })
  // A bank that was merely DOWN last time must be retried, not quarantined. If this returned
  // false, the sync route (which only resets a recovered item to 'ok' after consulting this
  // policy) would refresh balances but skip transactions for one extra round — the user would
  // have to press Refresh twice, with nothing on screen explaining why.
  it('DOES sync an item whose bank was only temporarily unavailable', () => {
    expect(
      shouldSyncTransactions({ products: ['transactions'], status: 'temporarily_unavailable' })
    ).toBe(true)
  })
  it('does not sync when products is null', () => {
    expect(shouldSyncTransactions({ products: null, status: 'ok' })).toBe(false)
  })
  // Rows predating migration 010 get status via a NOT NULL DEFAULT 'ok', so null should never
  // reach here — but if it ever did, a healthy bank silently never syncing again is the exact
  // failure this whole project exists to prevent. Fail open.
  it('syncs when status is null rather than silently quarantining the bank', () => {
    expect(shouldSyncTransactions({ products: ['transactions'], status: null })).toBe(true)
  })
  it('syncs a mixed item that includes transactions', () => {
    expect(shouldSyncTransactions({ products: ['transactions', 'liabilities'], status: 'ok' })).toBe(
      true
    )
  })
})
