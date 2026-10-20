import Link from 'next/link'
import { notSyncing } from '@/lib/bank-state'
import type { ItemSummary } from '@/lib/plaid-items'

// The warning every page that shows a bank's figures puts first, above its header, while any bank
// isn't syncing (#135). Stale numbers that look fine are the failure this app exists to prevent. It
// links to Settings, where a bank is reconnected. One component, so the dashboard, the breakdowns,
// budgets and trends say the same thing, the same way, and its phone layout is checked once.
export function NotSyncingBanner({ items }: { items: Pick<ItemSummary, 'institution_name' | 'status'>[] }) {
  const unhealthy = notSyncing(items)
  if (unhealthy.length === 0) return null
  const needsReconnect = unhealthy.some((i) => i.status === 'needs_reconnect')
  return (
    <Link
      href="/settings"
      className="block rounded-card border border-coral/40 bg-coral/10 px-4 py-3 text-sm text-coral"
    >
      {unhealthy.length === 1
        ? `${unhealthy[0].institution_name ?? 'A bank'} isn't syncing`
        : `${unhealthy.length} banks aren't syncing`}
      {needsReconnect
        ? ' — reconnect in Settings to resume. These figures may be out of date.'
        : ' — see Settings. These figures may be out of date.'}
    </Link>
  )
}
