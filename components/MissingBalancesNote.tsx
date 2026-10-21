import { RefreshButton } from '@/components/RefreshButton'
import { balancesBlocked, balancesPending, bySync, withoutAccounts } from '@/lib/bank-state'
import type { ItemSummary } from '@/lib/plaid-items'

// The note a page puts with its other notices while a bank has no accounts yet (#170): connected,
// but its first balance pull failed. Every figure leaves that bank out, and with other banks'
// accounts in, they look complete: net worth and cash on hand are sums over accounts, and its
// transactions can't arrive before its accounts do. So it is on the dashboard, every breakdown and
// Transactions, which read the accounts anyway. Not on Budgets, Trends or Reimbursable: they don't,
// and reading them there would be one more wait before the page shows (#156).
//
// In the words the dashboard uses when no bank has accounts (#164), split the same way: Refresh for
// the banks still syncing, whose balances it pulls; for the rest a promise of nothing, under the
// "isn't syncing" banner, which links to Settings. Never Connect: the bank is linked, and linking it
// again spends one of ten lifetime connections (#51). Quieter than that banner, since nothing is
// broken. One component, so every page says the same thing, the same way. `refreshButton` is false
// where the page already has a Refresh button, the dashboard's header, so there aren't two.
export function MissingBalancesNote({
  items,
  accounts,
  refreshButton = true,
}: {
  items: Pick<ItemSummary, 'id' | 'institution_name' | 'status'>[]
  accounts: { plaid_item_id: string }[]
  refreshButton?: boolean
}) {
  const { syncing, behind } = bySync(withoutAccounts(items, accounts))
  if (syncing.length === 0 && behind.length === 0) return null
  return (
    <div className="flex flex-col gap-3 rounded-card border border-line bg-surface px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sm text-muted">
        {[
          syncing.length ? `${balancesPending(syncing)} Press Refresh to fetch them.` : '',
          behind.length ? balancesBlocked(behind, { inSettings: true }) : '',
        ]
          .filter(Boolean)
          .join(' ')}
      </p>
      {syncing.length > 0 && refreshButton && <RefreshButton />}
    </div>
  )
}
