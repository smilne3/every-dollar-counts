'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { fastPathState, type FastPathEntry, type FastPathSplit, type PinnedClaim } from '@/lib/fast-path'

export function ReimbursableButton({
  transactionId,
  amount,
  splits,
  pinned,
  label,
}: {
  transactionId: string
  amount: number
  splits: FastPathSplit[]
  pinned: PinnedClaim[]
  label: string
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const state = fastPathState({ amount }, splits, pinned)
  if (!state.show) return null

  async function apply(entry: FastPathEntry) {
    setBusy(true)
    setError(null)
    try {
      // Applied entries undo; the rest assign whatever is still unsplit.
      const res = entry.applied
        ? await fetch('/api/reimbursements/splits', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: entry.splitId }),
          })
        : await fetch('/api/reimbursements/splits', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              transactionId,
              claimId: entry.claimId,
              owedBy: null,
              amount: entry.amount,
            }),
          })
      if (!res.ok) {
        // The splits API's 400s are written to be read by a user (a claim written off in another
        // tab, a delete that would orphan a repayment). Surface them rather than a generic message.
        const body = await res.json().catch(() => ({}))
        setError(body.error ?? 'That could not be saved.')
        return
      }
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  const linkClass = 'text-xs font-medium text-emerald hover:text-emerald-600 disabled:opacity-50'

  return (
    <div className="flex flex-col items-end gap-1">
      {state.entries.length === 1 ? (
        <button
          type="button"
          onClick={() => apply(state.entries[0])}
          disabled={busy}
          aria-label={
            state.entries[0].applied
              ? `Remove ${state.entries[0].claimName} from ${label}`
              : `Mark ${label} reimbursable to ${state.entries[0].claimName}`
          }
          className={linkClass}
        >
          {state.entries[0].applied
            ? `Reimbursable ✓`
            : `Reimbursable · ${state.entries[0].claimName}`}
        </button>
      ) : (
        // A native disclosure rather than a positioned popover: it works inside a table cell with no
        // layout maths, and is keyboard-accessible for free.
        <details className="text-right">
          <summary className={`${linkClass} cursor-pointer list-none`}>Reimbursable ▾</summary>
          <div className="mt-1 flex flex-col items-end gap-1">
            {state.entries.map((e) => (
              <button
                key={e.claimId}
                type="button"
                onClick={() => apply(e)}
                disabled={busy}
                aria-label={
                  e.applied
                    ? `Remove ${e.claimName} from ${label}`
                    : `Mark ${label} reimbursable to ${e.claimName}`
                }
                className={linkClass}
              >
                {e.applied ? `${e.claimName} ✓` : e.claimName}
              </button>
            ))}
          </div>
        </details>
      )}
      {error && (
        <span role="alert" className="text-xs text-rose-600">
          {error}
        </span>
      )}
    </div>
  )
}
