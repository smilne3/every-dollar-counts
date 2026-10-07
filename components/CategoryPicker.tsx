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

  // One wrapper for the select and its alert. Below md it is a full-width column, because the phone
  // sheet (TransactionCard.tsx) gives the picker the full width and has room for an alert beneath.
  // From md up an error must never grow or shift the desktop row (#50), and a message squeezed beside
  // the select into a ~128px cell cannot be read. So the alert floats below the select, positioned
  // against the `md:relative` wrapper: it takes no layout space, keeping the row's height, and gets
  // up to 16rem to wrap in. `md:max-w-full md:flex-nowrap` keep the select itself inside its cell.
  // The select's own `w-full md:w-auto` (selectClass) still sets its width.
  return (
    <span className="flex w-full min-w-0 flex-col gap-1 md:relative md:inline-flex md:w-auto md:max-w-full md:flex-row md:flex-nowrap md:items-center md:gap-1.5">
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
        <span role="alert" className="text-xs text-coral md:absolute md:left-0 md:top-full md:z-10 md:mt-1 md:w-max md:max-w-64 md:whitespace-normal md:rounded-md md:border md:border-line md:bg-surface md:px-2 md:py-1 md:shadow-sm">
          {error}
        </span>
      )}
    </span>
  )
}
