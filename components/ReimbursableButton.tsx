'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { money } from '@/lib/format'
import { fastPathState, type FastPathEntry, type FastPathSplit, type PinnedClaim } from '@/lib/fast-path'

// One place decides what a tap says it will do and what it announces, so the single-claim button and
// the dropdown rows can never drift apart. `solo` is the wording when this is the only entry (the
// control names itself); `text` is the wording inside the dropdown (the control is already named).
//
// The third case is the multi-split one: several splits already sit under this claim on this row, so
// the tap adds the remainder rather than undoing anything. It must never render as a bare "✓" —
// that is what invited the tap that used to delete a person's share.
function entryCopy(e: FastPathEntry, label: string) {
  if (e.action === 'undo') {
    return {
      solo: 'Reimbursable ✓',
      text: `${e.claimName} ✓`,
      aria: `Remove ${e.claimName} from ${label}`,
    }
  }
  if (e.applied) {
    const rest = money(e.amount)
    return {
      solo: `Reimbursable · ${e.claimName} + ${rest}`,
      text: `${e.claimName} + ${rest}`,
      aria: `Add the remaining ${rest} of ${label} to ${e.claimName}`,
    }
  }
  return {
    solo: `Reimbursable · ${e.claimName}`,
    text: e.claimName,
    aria: `Mark ${label} reimbursable to ${e.claimName}`,
  }
}

export function ReimbursableButton({
  transactionId,
  txn,
  splits,
  pinned,
  label,
}: {
  transactionId: string
  // The whole shape fastPathState needs: `pfc_detailed`/`user_category` are what identify a
  // credit-card payment, which the splits API refuses and this control therefore never offers.
  txn: { amount: number; pfc_detailed: string | null; user_category: string | null }
  splits: FastPathSplit[]
  pinned: PinnedClaim[]
  label: string
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const state = fastPathState(txn, splits, pinned)
  if (!state.show) return null

  async function apply(entry: FastPathEntry) {
    setBusy(true)
    setError(null)
    try {
      // The entry's own action decides — NOT whether the claim is applied. A claim with several
      // splits on this transaction is applied but has no single split to undo, so it assigns.
      const res = entry.action === 'undo'
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
          aria-label={entryCopy(state.entries[0], label).aria}
          className={linkClass}
        >
          {entryCopy(state.entries[0], label).solo}
        </button>
      ) : (
        // A native disclosure rather than a positioned popover: it works inside a table cell with no
        // layout maths, and is keyboard-accessible for free.
        <details className="text-right">
          <summary
            className={`${linkClass} cursor-pointer list-none`}
            aria-label={`Reimbursable options for ${label}`}
          >
            Reimbursable ▾
          </summary>
          <div className="mt-1 flex flex-col items-end gap-1">
            {state.entries.map((e) => (
              <button
                key={e.claimId}
                type="button"
                onClick={() => apply(e)}
                disabled={busy}
                aria-label={entryCopy(e, label).aria}
                className={linkClass}
              >
                {entryCopy(e, label).text}
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
