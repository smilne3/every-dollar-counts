'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { selectClass } from '@/components/ui/styles'

// The zone every date in the app is derived from (#73). Saved on change, like CategoryPicker —
// there is one field and nothing to confirm.

// Intl.supportedValuesOf is the browser's own list, so nothing here needs maintaining and moving
// or travelling is handled. Where it is unavailable, a short list keeps the control usable.
const FALLBACK_ZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Phoenix',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
  'UTC',
]

function zones(current: string): string[] {
  const supported =
    typeof Intl.supportedValuesOf === 'function'
      ? (Intl.supportedValuesOf('timeZone') as string[])
      : FALLBACK_ZONES
  // Always include what is stored, even if this browser does not enumerate it — otherwise the
  // control would silently show a different zone from the one in force.
  return supported.includes(current) ? supported : [current, ...supported]
}

export function TimezoneCard({ current }: { current: string }) {
  const router = useRouter()
  const [value, setValue] = useState(current)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function change(e: React.ChangeEvent<HTMLSelectElement>) {
    const next = e.target.value
    const previous = value
    setValue(next)
    setBusy(true)
    setError(null)
    const res = await fetch('/api/household/timezone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ timezone: next }),
    }).catch(() => null)
    setBusy(false)
    if (!res || !res.ok) {
      // Roll the control back, so it never shows a zone that was not saved.
      setValue(previous)
      const body = res ? ((await res.json().catch(() => ({}))) as { error?: string }) : {}
      setError(body.error ?? "That couldn't be saved. Please try again.")
      return
    }
    router.refresh()
  }

  return (
    <div className="space-y-2">
      <select
        value={value}
        onChange={change}
        disabled={busy}
        aria-label="Time zone"
        className={selectClass}
      >
        {zones(value).map((z) => (
          <option key={z} value={z}>
            {z.replace(/_/g, ' ')}
          </option>
        ))}
      </select>
      <p className="text-xs text-faint">
        Every date in the app — the month your budgets cover, what counts as today — is worked out
        in this zone.
      </p>
      {error && (
        <p role="alert" className="text-sm text-coral">
          {error}
        </p>
      )}
    </div>
  )
}
