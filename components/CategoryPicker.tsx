'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { selectClass } from './ui/styles'

const SAVE_FAILED = 'That could not be saved.'
const SESSION_ENDED = 'Your session ended. Sign in again.'

export function CategoryPicker({
  transactionId,
  value,
  options,
  label,
  onBusyChange,
}: {
  transactionId: string
  value: string
  options: string[]
  label?: string
  // Told whenever a save starts and stops, so a host that can UNMOUNT this control (the phone sheet)
  // can refuse to close over a request in flight; a failed save's message would otherwise land on an
  // unmounted component and be lost. The desktop row passes nothing.
  onBusyChange?: (busy: boolean) => void
}) {
  const router = useRouter()
  // The choice being saved, shown in place of the server's value until the save settles. On failure
  // it is dropped, so the picker falls back to the server's CURRENT value, even one that arrived by
  // refresh while the request was in flight. Rolling back to the value captured at event time would
  // undo that newer value with nothing left to correct it (#102).
  const [pending, setPending] = useState<string | null>(null)
  const val = pending ?? value
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Follow the server. When a refresh brings a new value (another household member, or a rule from
  // PR 2), show it and drop any optimistic choice or alert. React's documented way to adjust
  // state when a prop changes; the same idiom as ReimbursableCheckbox.
  const [seen, setSeen] = useState(value)
  if (seen !== value) {
    setSeen(value)
    setPending(null)
    setError(null)
  }

  // The current value is always selectable, even when it is 'Uncategorized' or a stale name.
  const opts = options.includes(val) ? options : [val, ...options]

  function working(now: boolean) {
    setSaving(now)
    onBusyChange?.(now)
  }

  async function change(e: React.ChangeEvent<HTMLSelectElement>) {
    const category = e.target.value
    setPending(category)
    working(true)
    setError(null)
    let saved = false
    try {
      const res = await fetch('/api/transactions/categorize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transactionId, category }),
      })
      const body = (await res.json().catch(() => null)) as { ok?: unknown; error?: unknown } | null
      // A signed-out call is redirected to /login and fetch follows it to an HTML page: a 200 that
      // saved nothing. Only the route's own JSON `ok: true` is a save. A non-OK response whose body
      // is not JSON (an HTML 5xx page, say) is a failed save, not an ended session, and falls through.
      if (res.redirected || (res.ok && body === null)) {
        setPending(null)
        setError(SESSION_ENDED)
        return
      }
      if (!res.ok || body?.ok !== true) {
        // Back to what the server has (the prop), not to the last local value (#102).
        setPending(null)
        setError(typeof body?.error === 'string' ? body.error : SAVE_FAILED)
        return
      }
      saved = true
    } catch {
      setPending(null)
      setError(SAVE_FAILED)
    } finally {
      // `disabled` means "in flight", never "has failed".
      working(false)
    }
    // Outside the try: a throw from refresh is not a failed save.
    if (saved) router.refresh()
  }

  // One wrapper for the select and its alert: a column at every width, the alert in flow directly
  // under the select. Spec §8.2's one-line rule exists for #50, so that routine taps never shift
  // rows. A failed save is rare and has to be readable, and in the ~128px desktop Category cell every
  // no-growth layout either hides the message (truncated beside the select), covers the next row
  // (floated below it), or is clipped on the last row by the table's overflow-x-auto box. So while a
  // save error shows, that one row grows (by up to about four lines in the narrowest ~128px cell for
  // the longest message) until the next pick or a refresh clears it. On desktop the column stretches
  // the select to the Category cell's width, and `md:max-w-full` keeps it inside the cell, which also
  // stops a long option name running into the Amount column (#138).
  return (
    <span className="flex w-full min-w-0 flex-col gap-1 md:w-auto md:max-w-full">
      <select
        value={val}
        onChange={change}
        disabled={saving}
        aria-label={label ? `Category for ${label}` : 'Transaction category'}
        className={selectClass}
      >
        {opts.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
      {error && (
        <span role="alert" className="text-xs text-coral">
          {error}
        </span>
      )}
    </span>
  )
}
