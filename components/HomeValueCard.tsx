'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/Button'
import { inputClass } from '@/components/ui/styles'
import { money } from '@/lib/format'
import { MAY_NOT_HAVE_SAVED, sendSave } from '@/lib/save-response'

// Edits the household's home value. Enter what Zillow shows; the app subtracts the live mortgage
// automatically (it's already a liability), so net worth reflects home equity.
export function HomeValueCard({
  initialValue,
  updatedAt,
}: {
  initialValue: number | null
  updatedAt: string | null
}) {
  const router = useRouter()
  const [value, setValue] = useState(initialValue != null ? String(initialValue) : '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save(e: React.FormEvent) {
    e.preventDefault()
    // As on the button: Enter in the field submits the form too.
    if (busy) return
    // Accept what Zillow shows verbatim — "$750,000" — by stripping $, commas, and spaces. The
    // card tells the user to copy from Zillow, so this must parse the way Zillow formats it. A blank
    // field is no value, as in the route: Number('') is 0, which would set the home to $0.
    const text = value.replace(/[$,\s]/g, '')
    const v = text === '' ? NaN : Number(text)
    if (!Number.isFinite(v) || v < 0) {
      setError('Enter your home value, e.g. 750000 or $750,000.')
      return
    }
    setBusy(true)
    setError(null)
    let reload = false
    try {
      // The shared rule (lib/save-response.ts): only the route's own { ok: true } is a save. Checking
      // res.ok alone read a save made after the session ended as saved: the request is redirected to
      // the login page, which answers 200.
      const result = await sendSave('/api/manual-assets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: v }),
      })
      if (result.outcome === 'saved') {
        reload = true
      } else if (result.outcome === 'refused') {
        // The route's own words: the environment guard's 409 is a misconfiguration, and "please try
        // again" is advice that can never succeed. What was typed stays, so trying again is one tap.
        setError(result.error)
      } else {
        // It may have saved. What was typed stays, since saving again sets the same value; the
        // reload's "Currently" line shows what is stored.
        console.error('[HomeValueCard] save failed', result.cause)
        setError(MAY_NOT_HAVE_SAVED)
        reload = true
      }
    } finally {
      // Never left on "Saving…".
      setBusy(false)
    }
    // Outside the try: a throw from refresh is not a failed save.
    if (reload) router.refresh()
  }

  return (
    <form onSubmit={save} className="space-y-2">
      {initialValue != null && (
        <p className="text-sm text-muted">
          Currently {money(initialValue)}
          {updatedAt && ` · updated ${new Date(updatedAt).toLocaleDateString()}`}
        </p>
      )}
      <div className="flex max-w-sm items-center gap-2">
        <input
          inputMode="numeric"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="e.g. 750000"
          // Fixed while a save is in flight, so what was sent is what stays on screen.
          disabled={busy}
          className={inputClass}
          aria-label="Home value"
        />
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
      </div>
      <p className="text-xs text-faint">
        Check Zillow for your estimate and enter it here. Your mortgage is subtracted automatically.
      </p>
      {error && (
        <p role="alert" className="text-sm text-coral">
          {error}
        </p>
      )}
    </form>
  )
}
