import { describe, it, expect, vi } from 'vitest'

// Mock the Plaid client: page 1 has_more, page 2 finishes.
vi.mock('@/lib/plaid', () => ({
  plaidClient: {
    transactionsSync: vi
      .fn()
      .mockResolvedValueOnce({
        data: { added: [{ transaction_id: '1' }], modified: [], removed: [], has_more: true, next_cursor: 'c1' },
      })
      .mockResolvedValueOnce({
        data: { added: [{ transaction_id: '2' }], modified: [{ transaction_id: '3' }], removed: [], has_more: false, next_cursor: 'c2' },
      }),
  },
}))

import { syncItem } from '@/lib/sync'

describe('syncItem', () => {
  it('drains all pages and returns the final cursor', async () => {
    const r = await syncItem('access-sandbox-x', undefined)
    expect(r.added).toHaveLength(2)
    expect(r.modified).toHaveLength(1)
    expect(r.next_cursor).toBe('c2')
  })
})
