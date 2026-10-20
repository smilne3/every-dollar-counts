'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { selectClass } from '@/components/ui/styles'
import { MAY_NOT_HAVE_SAVED, sendSave } from '@/lib/save-response'

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
  // As CategoryRulesCard: the zone being saved shows until the save settles. On anything but a save
  // it is dropped and the select falls back to the stored zone, so it never shows a zone that was
  // not saved.
  const [pending, setPending] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Follow the server: the reload after "It may not have saved" can bring the new zone, and one set
  // on the other phone arrives the same way. Seeded once, the select would go on showing the zone it
  // rolled back to. React's documented way to adjust state when a prop changes.
  const [seen, setSeen] = useState(current)
  if (seen !== current) {
    setSeen(current)
    setPending(null)
  }
  const value = pending ?? current

  async function change(e: React.ChangeEvent<HTMLSelectElement>) {
    const next = e.target.value
    setPending(next)
    setBusy(true)
    setError(null)
    let reload = false
    try {
      // The shared rule (lib/save-response.ts): only the route's own { ok: true } is a save. Checking
      // res.ok alone read a change made after the session ended as saved: the request is redirected
      // to the login page, which answers 200.
      const result = await sendSave('/api/household/timezone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timezone: next }),
      })
      if (result.outcome === 'saved') {
        reload = true
      } else if (result.outcome === 'refused') {
        setPending(null)
        setError(result.error)
      } else {
        // It may have saved: back to the stored zone, and the reload shows which it is.
        console.error('[TimezoneCard] save failed', result.cause)
        setPending(null)
        setError(MAY_NOT_HAVE_SAVED)
        reload = true
      }
    } finally {
      // Never left disabled.
      setBusy(false)
    }
    // Outside the try: a throw from refresh is not a failed save.
    if (reload) router.refresh()
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
