'use client'

import { useEffect } from 'react'
import { Card } from '@/components/ui/Card'

// Route-segment error boundary for everything under app/(app) — dashboard, transactions, budgets,
// reimbursements, trends, goals, settings. Without this, one failed query (fetchReceivable throws
// deliberately on a read error, per #46: "the query failed" and "you are owed nothing" must never
// render identically) took down the ENTIRE app, because Next had no boundary between an uncaught
// render error and the root of the tree. app/error.tsx, added since, sits above the layout and is
// there for its sign-in check (#143).
//
// This does NOT swallow or disguise the error — that would defeat the reason fetchReceivable throws
// in the first place. It only shrinks the blast radius: the sidebar and nav (rendered by
// app/(app)/layout.tsx, which sits above this boundary and is unaffected) stay usable, and the failed
// section shows a plain "couldn't load" message with a retry instead of a blank/crashed page. It
// makes no promise about the other pages: a read most of them share, like the bank list behind the
// "isn't syncing" banner (#171), fails on every one of them at once.
// `retry`, not `unstable_retry`: Next 16.3 made the prop stable under its new name, and the old one is
// never passed, so a button calling it does nothing. tests/unit/app-error-boundary.test.tsx holds these
// props to the ones Next's error boundary passes (its ErrorInfo type).
export default function AppSegmentError({
  error,
  retry,
}: {
  error: Error & { digest?: string }
  retry: () => void
}) {
  useEffect(() => {
    // Deliberate: this is the fail-loud path, not a place to go quiet. Swap for a real
    // error-reporting call if one is ever added to this app.
    console.error(error)
  }, [error])

  return (
    <div className="grid place-items-center py-16">
      <Card className="max-w-sm p-8 text-center">
        <h2 className="text-lg font-semibold text-ink">This section couldn&apos;t load</h2>
        <p className="mt-2 text-sm text-muted">
          Something went wrong fetching this data. Try again, or come back in a moment.
        </p>
        {error.message && (
          <p className="mt-3 break-words text-xs text-coral" role="alert">
            {error.message}
          </p>
        )}
        <button
          type="button"
          onClick={() => retry()}
          className="mt-4 inline-block text-sm font-medium text-emerald hover:text-emerald-600"
        >
          Try again
        </button>
      </Card>
    </div>
  )
}
