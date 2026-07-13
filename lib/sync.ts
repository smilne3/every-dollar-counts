import { plaidClient } from '@/lib/plaid'
import type { Transaction, RemovedTransaction } from 'plaid'

export type SyncResult = {
  added: Transaction[]
  modified: Transaction[]
  removed: RemovedTransaction[]
  next_cursor?: string
}

// Drains all pages of transactions/sync, returning the accumulated changes and
// the FINAL cursor (only safe to persist after the whole loop completes).
export async function syncItem(access_token: string, cursor?: string): Promise<SyncResult> {
  let added: Transaction[] = []
  let modified: Transaction[] = []
  let removed: RemovedTransaction[] = []
  let hasMore = true
  let next = cursor

  // Safety cap: 500 pages x up to 500 txns = 250k changes — far beyond any real
  // household, but prevents an unbounded loop if the API misbehaves.
  let pages = 0
  while (hasMore && pages < 500) {
    const { data } = await plaidClient.transactionsSync({ access_token, cursor: next })
    added = added.concat(data.added)
    modified = modified.concat(data.modified)
    removed = removed.concat(data.removed)
    hasMore = data.has_more
    next = data.next_cursor
    pages++
  }

  return { added, modified, removed, next_cursor: next }
}
