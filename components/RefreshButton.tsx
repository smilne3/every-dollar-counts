'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { buttonClass } from '@/components/ui/Button'
import { RefreshIcon } from '@/components/ui/icons'
import { sendRequest } from '@/lib/save-response'

// How long a Refresh may take before it counts as lost (#165). The route syncs each bank in turn,
// two Plaid calls and a few writes apiece, so with six banks linked a healthy refresh can pass a
// save's 20 seconds. Giving up early cannot misreport: the server carries on, the reload shows what
// has landed, and pressing Refresh again only repeats work, since rows are upserted by id.
export const REFRESH_TIMEOUT_MS = 60_000

// For a refresh whose reply was lost, timed out or could not be read: the sync may still finish on
// the server, so neither success nor failure is known.
const MAY_NOT_HAVE_FINISHED = 'It may not have finished. Showing the latest.'

// The counts the route answers with (app/api/plaid/sync-transactions/route.ts).
type SyncCounts = { banks: number; added: number; brokenNow: number; failed: number; skipped: number }
const COUNTS = ['banks', 'added', 'brokenNow', 'failed', 'skipped'] as const

// Only the route's own answer: ok: true and every count. Anything else did not come from a sync
// that finished, and its missing counts would read as zero, so as nothing new (#119).
function syncCounts(body: Record<string, unknown>): SyncCounts | null {
  return body.ok === true && COUNTS.every((k) => typeof body[k] === 'number') ? (body as unknown as SyncCounts) : null
}

export function RefreshButton() {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [isProblem, setIsProblem] = useState(false)

  async function refresh() {
    setBusy(true)
    setMessage(null)
    let reload = false
    try {
      const result = await sendRequest('/api/plaid/sync-transactions', { method: 'POST' }, REFRESH_TIMEOUT_MS)
      const counts = result.outcome === 'answered' ? syncCounts(result.body) : null

      // A refresh that quietly swallowed its own result is how the numbers go stale without
      // anyone noticing — the exact failure this whole project exists to prevent.
      if (counts) {
        const bad = counts.brokenNow + counts.failed + counts.skipped
        const ok = counts.banks - bad
        if (bad > 0) {
          setIsProblem(true)
          setMessage(
            `Updated ${ok} of ${counts.banks} banks — ${bad} need${bad === 1 ? 's' : ''} attention. See Settings.`
          )
        } else {
          setIsProblem(false)
          // Only what is known: Plaid had nothing new. When Plaid is behind the bank, "Everything up
          // to date" told someone looking for a missing deposit that nothing was missing (#119).
          setMessage(
            counts.added ? `Updated ${counts.banks} banks · ${counts.added} new` : 'No new transactions from Plaid yet'
          )
        }
        reload = true
      } else if (result.outcome === 'refused') {
        // The route's words, or "Your session ended. Sign in again." for the login page, which used
        // to read as an empty sync (#119). Nothing was synced, so there is nothing to reload.
        setIsProblem(true)
        setMessage(result.error)
      } else {
        console.error('[RefreshButton] refresh failed', result.outcome === 'unknown' ? result.cause : result.body)
        setIsProblem(true)
        setMessage(MAY_NOT_HAVE_FINISHED)
        reload = true
      }
    } finally {
      // Never left spinning.
      setBusy(false)
    }
    // Outside the try: a throw from refresh is not a failed sync.
    if (reload) router.refresh()
  }

  return (
    <div className="flex items-center gap-2">
      {message && (
        <span className={`text-xs ${isProblem ? 'text-coral' : 'text-muted'}`}>{message}</span>
      )}
      <button onClick={refresh} disabled={busy} className={buttonClass('secondary', 'md')}>
        <RefreshIcon className={`h-4 w-4 ${busy ? 'animate-spin' : ''}`} />
        {busy ? 'Refreshing…' : 'Refresh'}
      </button>
    </div>
  )
}
