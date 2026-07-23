// Whether we should call transactions/sync for an item. Investment and loan items are
// balances-only; an item whose bank is broken or down is skipped until it recovers.
//
// Why the guard exists: calling transactions/sync on such an item does NOT error. Plaid
// returns empty arrays and quietly ADDS the Transactions product to that Item — a
// subscription-billed product on an Item that will never use it, plus a pointless historical
// pull. Because it doesn't error, "no transactions appeared" does not prove the guard works;
// assert the item's `cursor` is still NULL instead.
// Only 'needs_reconnect' blocks a sync, and deliberately so. 'temporarily_unavailable' means the
// bank was down on the LAST attempt — retrying is exactly what should happen next time. Requiring
// status === 'ok' here looks stricter and safer but is a bug: the sync route resets a recovered
// item to 'ok' only AFTER the policy has been evaluated, so a bank that had a transient blip would
// refresh balances but silently skip transactions for one whole extra round, leaving the user to
// press Refresh twice with no indication why.
export function shouldSyncTransactions(item: {
  products: string[] | null
  status: string | null
}): boolean {
  return (item.products ?? []).includes('transactions') && item.status !== 'needs_reconnect'
}
