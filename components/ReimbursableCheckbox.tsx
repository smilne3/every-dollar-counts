'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { money } from '@/lib/format'
import { isCreditCardPayment } from '@/lib/categories'

export function ReimbursableCheckbox({
  transactionId,
  amount,
  reimbursableAmount,
  note,
  label,
  pfcDetailed = null,
  userCategory = null,
}: {
  transactionId: string
  amount: number
  reimbursableAmount: number | null
  note?: string | null
  label: string
  pfcDetailed?: string | null
  userCategory?: string | null
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Guards #31: the route refuses these, so offering the control would only ever produce an error.
  if (isCreditCardPayment({ pfc_detailed: pfcDetailed, user_category: userCategory })) return null

  const marked = Number(reimbursableAmount ?? 0)
  const full = Math.abs(amount)
  const partial = marked > 0 && marked < full

  async function set(next: number | null) {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/reimbursable', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        // Clearing the mark clears the memo too: a note left behind on an unmarked transaction is
        // orphaned data (`reimbursable_note` set with `reimbursable_amount` null) that has no
        // reason to exist and nowhere it is shown.
        body: JSON.stringify({ transactionId, amount: next, note: next === null ? null : (note ?? null) }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setError(body.error ?? 'That could not be saved.')
        return
      }
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  // A partial mark has no honest tick state — see the test. Show what is marked; the editor in the
  // row menu is where it changes.
  if (partial) {
    return (
      <span className="text-xs font-medium text-emerald" title={note ?? undefined}>
        {money(marked)} of {money(full)}
      </span>
    )
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <label className="flex cursor-pointer items-center gap-1.5 text-xs font-medium text-emerald hover:text-emerald-600">
        <input
          type="checkbox"
          checked={marked > 0}
          onChange={() => set(marked > 0 ? null : full)}
          disabled={busy}
          aria-label={`Reimbursable — ${label}`}
          className="h-3.5 w-3.5 accent-emerald disabled:opacity-50"
        />
      </label>
      {error && (
        <span role="alert" className="text-xs text-coral">
          {error}
        </span>
      )}
    </div>
  )
}
