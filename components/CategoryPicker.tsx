'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { selectClass } from './ui/styles'

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
  // Told whenever a save starts and stops, so a host that can UNMOUNT this control — the phone
  // sheet, whose children are gated on `open` — can refuse to close over a request in flight. The
  // error below is set after the await, and React silently no-ops a setState on an unmounted
  // component, so without somewhere for it to land a failed save is discarded before it is shown.
  // Optional: the desktop row is mounted for the life of the page and passes nothing.
  onBusyChange?: (busy: boolean) => void
}) {
  const router = useRouter()
  const [val, setVal] = useState(value)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Ensure the current value is selectable even if it's 'Uncategorized' or stale.
  const opts = options.includes(val) ? options : [val, ...options]

  // One place to change both, so the host's view of "in flight" cannot drift from the control's own.
  function working(now: boolean) {
    setSaving(now)
    onBusyChange?.(now)
  }

  async function change(e: React.ChangeEvent<HTMLSelectElement>) {
    const category = e.target.value
    // What to fall back to if the save is refused. Read before the optimistic update, not after.
    const previous = val
    setVal(category)
    working(true)
    setError(null)
    try {
      const res = await fetch('/api/transactions/categorize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transactionId, category }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        // Put the picker back where the server still has it. An optimistic value that survives a
        // rejection is a lie: it shows a category that was never saved, and the next refresh
        // silently replaces it with the old one for no visible reason (#97).
        setVal(previous)
        // The route's refusals are written to be read aloud — an unknown category, or a
        // credit-card payment (#98). A generic message would discard the only actionable part.
        setError(body.error ?? 'That could not be saved.')
        return
      }
      router.refresh()
    } catch {
      // Same reasoning as the !res.ok branch — the request never landed, so the value must not stand.
      setVal(previous)
      setError('That could not be saved.')
    } finally {
      // `disabled` means "in flight", never "has failed": leaving it disabled after a rejection
      // would strand the user on the wrong category with no way to try again.
      working(false)
    }
  }

  // A fragment, deliberately: a wrapper would establish a new box around the <select> and change
  // its width in both surfaces at once. The desktop cell sizes the picker to its content, the phone
  // sheet's `flex flex-col` label stretches it full width, and neither of those is this component's
  // decision to make. `block` on the error gives it its own line in the table cell and is a no-op
  // in the sheet, where flex items are blockified anyway.
  return (
    <>
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
        <span role="alert" className="block text-xs text-coral">
          {error}
        </span>
      )}
    </>
  )
}
