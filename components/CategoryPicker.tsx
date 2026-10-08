'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { ResolvedCategory } from '@/lib/category-rules'
import { selectClass } from './ui/styles'

const SAVE_FAILED = 'That could not be saved.'
const SESSION_ENDED = 'Your session ended. Sign in again.'
// The request may have reached the server and written before the reply was lost (a phone dropping
// signal mid-request), so "could not be saved" would be a guess. Say so, and reload to show the truth.
const MAY_NOT_HAVE_SAVED = 'It may not have saved. Showing the latest.'

export function CategoryPicker({
  transactionId,
  value,
  source,
  options,
  label,
  onBusyChange,
}: {
  transactionId: string
  value: string
  // Why the server shows `value`: a pick, a rule or the bank. Part of the re-sync key below.
  source: ResolvedCategory['source']
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
  // Follow the server. When a refresh brings a new value, or the same name for a new reason (a rule
  // equal to the bank's category is removed: rule → bank), show it and drop any optimistic choice
  // or alert. React's documented way to adjust state when a prop changes; the same idiom as
  // components/ReimbursableCheckbox.tsx.
  const serverKey = `${source}:${value}`
  const [seen, setSeen] = useState(serverKey)
  if (seen !== serverKey) {
    setSeen(serverKey)
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
    // What to do once the request has settled: reload after a save, or after one whose outcome is
    // unknown. Never while it is in flight, and never after a refusal.
    let reload = false
    try {
      const res = await fetch('/api/transactions/categorize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transactionId, category }),
      })
      const isJson = (res.headers.get('content-type') ?? '').includes('application/json')
      // A signed-out call is redirected to /login and fetch follows it to an HTML page: a 200 that
      // saved nothing. The route always answers in JSON, so a 200 that is not JSON is not its reply.
      // A non-OK reply that is not JSON (an HTML 5xx page, say) is a failed save, not an ended
      // session, and falls through.
      if (res.redirected || (res.ok && !isJson)) {
        setPending(null)
        setError(SESSION_ENDED)
        return
      }
      let body: { ok?: unknown; error?: unknown } | null = null
      let unreadable: { err: unknown } | null = null
      if (isJson) {
        try {
          body = await res.json()
        } catch (err) {
          unreadable = { err }
        }
      }
      if (res.ok && unreadable) {
        // The route's own 200 that cannot be read. It only answers 200 after the write, so the save
        // probably landed, but nothing here can say so. Treated like a request that never landed.
        throw unreadable.err
      }
      if (!res.ok || body?.ok !== true) {
        // Back to what the server has (the prop), not to the last local value (#102).
        setPending(null)
        setError(typeof body?.error === 'string' ? body.error : SAVE_FAILED)
        return
      }
      reload = true
    } catch (err) {
      // The request failed in flight, or its 200 could not be read. Neither means it never reached
      // the server.
      console.error('[CategoryPicker] save failed', err)
      setPending(null)
      setError(MAY_NOT_HAVE_SAVED)
      reload = true
    } finally {
      // `disabled` means "in flight", never "has failed".
      working(false)
    }
    // Outside the try: a throw from refresh is not a failed save.
    if (reload) router.refresh()
  }

  // One wrapper for the select and its alert: a column at every width, the alert in flow directly
  // under the select. Spec §8.2 asks for one line so a routine tap never moves other rows (the
  // principle behind #50). A failed save is rare and has to be readable, and in the narrow fixed
  // Category column every no-growth layout failed: truncated beside the select it hid the message,
  // floated below it covered the next row, and on the last row the table's overflow-x-auto box
  // clipped it. So while a save error shows, that one row grows, until the next pick, a new value
  // from the server, or a page reload clears it. On desktop the column stretches the select to the
  // Category cell's width, and `md:max-w-full` keeps it inside the cell, which also stops a long
  // option name running into the Amount column (#138).
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
