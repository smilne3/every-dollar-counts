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

export function TimezoneCard({
  current,
  readAt,
}: {
  current: string
  // When the page read the zone, by the server's clock (#182).
  readAt: number
}) {
  const router = useRouter()
  // As CategoryRulesCard: the zone being saved shows until the save settles, and once saved, until a
  // reload that read after it arrives. On anything but a save it goes back to what it was before the
  // change, so the select falls back to the stored zone and never shows a zone that was not saved.
  const [pending, setPending] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // When the last save confirmed here was written, by the server's clock: 0 until one is (#182).
  const [savedAt, setSavedAt] = useState(0)
  // Follow the server: the reload after "It may not have saved" can bring the new zone, and one set
  // on the other phone arrives the same way. Seeded once, the select would go on showing the zone it
  // rolled back to. Reloads are told apart by when they read, not by the zone they bring: told apart
  // by zone, one bringing back the zone shown before a save, set again on the other phone, was not
  // followed. React's documented way to adjust state when a prop changes.
  const [seen, setSeen] = useState(readAt)
  // Set when a change is not saved, to follow the page again as it is: a reload that landed while
  // the change was in flight was held back, and may be newer than the zone the select goes back to.
  // Nothing reloads after a refusal to bring it again (#182).
  const [reapply, setReapply] = useState(false)
  if (seen !== readAt || reapply) {
    setSeen(readAt)
    setReapply(false)
    // Only a read made after a save can hold the zone it wrote (#182). With two quick changes, the
    // reload asked for after the first can read the zone before the second writes it and land after
    // it: followed, it put the first zone back in the select once the second had saved. So the zone
    // saved here gives way to the page's only when no save is in flight, when the time of the write
    // is not known yet, and the page read after the last save was written.
    if (!busy && readAt > savedAt) setPending(null)
  }
  const value = pending ?? current

  async function change(e: React.ChangeEvent<HTMLSelectElement>) {
    const next = e.target.value
    // A zone saved here that no reload has caught up with yet, or null: what the select goes back to
    // if this change is not saved. Back to the page's zone instead, it could show one read before
    // that save, as if the save were undone.
    const before = pending
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
        // From here on, a read made before this write carries the zone it replaced.
        if (result.savedAt !== undefined) setSavedAt(result.savedAt)
        reload = true
      } else if (result.outcome === 'refused') {
        setPending(before)
        setReapply(true)
        setError(result.error)
      } else {
        // It may have saved: back to the stored zone, and the reload shows which it is.
        console.error('[TimezoneCard] save failed', result.cause)
        setPending(before)
        setReapply(true)
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
