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
  // Optimistic tick state. Without it `checked` stays bound to the server's value for the whole
  // PATCH + router.refresh() round trip, so the browser's native toggle is snapped back by React on
  // the very next render and the box reads as broken until the refresh lands (#50). Null means
  // "no click outstanding — trust the prop"; it is reset on failure, and after a success the
  // refreshed prop already agrees with it.
  const [optimistic, setOptimistic] = useState<number | null>(null)

  // Guards #31: the route refuses these, so offering the control would only ever produce an error.
  if (isCreditCardPayment({ pfc_detailed: pfcDetailed, user_category: userCategory })) return null

  const marked = optimistic ?? Number(reimbursableAmount ?? 0)
  const full = Math.abs(amount)
  const partial = marked > 0 && marked < full

  async function set(next: number | null) {
    setBusy(true)
    setError(null)
    setOptimistic(next ?? 0)
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
        // Put the box back where the server still has it. An optimistic tick that survives a
        // rejection is a lie: it would show the charge as coming back when nothing was saved.
        setOptimistic(null)
        setError(body.error ?? 'That could not be saved.')
        return
      }
      router.refresh()
    } catch {
      // Same reasoning as the !res.ok branch — the request never landed, so the tick must not stand.
      setOptimistic(null)
      setError('That could not be saved.')
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
