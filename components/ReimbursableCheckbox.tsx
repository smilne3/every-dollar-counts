'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { money } from '@/lib/format'
import { isCreditCardPayment } from '@/lib/categories'
import { MAY_NOT_HAVE_SAVED, sendSave } from '@/lib/save-response'

export function ReimbursableCheckbox({
  transactionId,
  amount,
  reimbursableAmount,
  note,
  label,
  pfcDetailed = null,
  userCategory = null,
  onBusyChange,
}: {
  transactionId: string
  amount: number
  reimbursableAmount: number | null
  note?: string | null
  label: string
  pfcDetailed?: string | null
  userCategory?: string | null
  // Told whenever a PATCH starts and stops, so a host that can UNMOUNT this control — the phone
  // sheet, whose children are gated on `open` — can refuse to close over a request in flight. The
  // error below is set after the await, and React silently no-ops a setState on an unmounted
  // component, so without somewhere for it to land a failed save is discarded before it is shown.
  // Optional: the desktop row is mounted for the life of the page and passes nothing.
  onBusyChange?: (busy: boolean) => void
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
  // Drop the optimistic value the moment the server's own value changes. Without this it outlives
  // its click: tick a $100 dinner here, then set it to $40 in the ⋮ editor, and this box
  // would still read "all of it is coming back" beside an amount cell saying "your share -$60.00" —
  // the row contradicting itself. React's documented way to adjust state when a prop changes.
  const [seen, setSeen] = useState(reimbursableAmount)
  if (seen !== reimbursableAmount) {
    setSeen(reimbursableAmount)
    setOptimistic(null)
  }

  // Guards #31: the route refuses these, so offering the control would only ever produce an error.
  if (isCreditCardPayment({ pfc_detailed: pfcDetailed, user_category: userCategory })) return null

  const marked = optimistic ?? Number(reimbursableAmount ?? 0)
  const full = Math.abs(amount)
  const partial = marked > 0 && marked < full

  // One place to change both, so the host's view of "in flight" cannot drift from the control's own.
  function working(now: boolean) {
    setBusy(now)
    onBusyChange?.(now)
  }

  async function set(next: number | null) {
    working(true)
    setError(null)
    setOptimistic(next ?? 0)
    // Reload after a save, after a refusal that says this row is stale, and after an unknown outcome.
    let reload = false
    try {
      // The shared rule (lib/save-response.ts): only the route's own { ok: true } is a save.
      const result = await sendSave('/api/reimbursable', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        // Clearing the mark clears the memo too: a note left behind on an unmarked transaction is
        // orphaned data (`reimbursable_note` set with `reimbursable_amount` null) that has no
        // reason to exist and nowhere it is shown.
        body: JSON.stringify({ transactionId, amount: next, note: next === null ? null : (note ?? null) }),
      })
      if (result.outcome === 'saved') {
        reload = true
      } else {
        // Put the box back where the server has it, on every outcome but a save. An optimistic tick
        // that survives a failed save is a lie: it would show the charge as coming back when nothing
        // was saved. After an unknown outcome the reload shows whether it was.
        setOptimistic(null)
        if (result.outcome === 'refused') {
          setError(result.error)
          // 404 and 409: the server says this row is stale, so show the latest under the message.
          reload = result.status === 404 || result.status === 409
        } else {
          console.error('[ReimbursableCheckbox] save failed', result.cause)
          setError(MAY_NOT_HAVE_SAVED)
          reload = true
        }
      }
    } finally {
      working(false)
    }
    // Outside the try: a throw from refresh is not a failed save.
    if (reload) router.refresh()
  }

  // A partial mark has no honest tick state — see the test. Show what is marked; the ⋮ editor is
  // where it changes.
  if (partial) {
    return (
      <span className="text-xs font-medium text-emerald" title={note ?? undefined}>
        {money(marked)} of {money(full)}
      </span>
    )
  }

  return (
    <div className="flex flex-col items-end gap-1">
      {/* §7 wants a 44px minimum tap target on every control. The box is 14x14 and this label holds
          no text to enlarge the hit area, so on a phone the whole target was 14x14 — the smallest
          control in the app. The minimum goes on the LABEL, which is the hit area a tap actually
          lands on, and `justify-center` centres the box inside it, so the box still looks 14px and
          only the reachable area grows. Released at `md`, where the desktop cell is right-aligned
          and this label has always been content width. */}
      <label className="flex min-h-[44px] min-w-[44px] cursor-pointer items-center justify-center gap-1.5 text-xs font-medium text-emerald hover:text-emerald-600 md:min-h-0 md:min-w-0 md:justify-start">
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
