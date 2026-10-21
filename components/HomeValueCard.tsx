'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/Button'
import { inputClass } from '@/components/ui/styles'
import { money } from '@/lib/format'
import { MAY_NOT_HAVE_SAVED, sendSave } from '@/lib/save-response'

// The field's text for a value the server holds: blank for none.
const valueText = (value: number | null) => (value != null ? String(value) : '')

// The value a field's text stands for, read as the route reads it. Accept what Zillow shows
// verbatim — "$750,000" — by stripping $, commas, and spaces. The card tells the user to copy from
// Zillow, so this must parse the way Zillow formats it. A blank field is no value (NaN), as in the
// route: Number('') is 0, which would set the home to $0.
function amount(text: string) {
  const stripped = text.replace(/[$,\s]/g, '')
  return stripped === '' ? NaN : Number(stripped)
}

// The same value however it is written: "$750,000" and "750000" are one value. Object.is, so two
// blanks (NaN) are the same too.
const sameValue = (a: string, b: string) => Object.is(amount(a), amount(b))

// Edits the household's home value. Enter what Zillow shows; the app subtracts the live mortgage
// automatically (it's already a liability), so net worth reflects home equity.
export function HomeValueCard({
  initialValue,
  updatedAt,
  readAt,
}: {
  initialValue: number | null
  updatedAt: string | null
  // When the page read initialValue, by the server's clock (#174).
  readAt: number
}) {
  const router = useRouter()
  const [value, setValue] = useState(valueText(initialValue))
  // The field's base, as in BudgetEditor: what it was last filled with from the server, or last
  // sent, or what was typed once a read shows the server has it. A field that still equals it holds
  // nothing typed since; one that does not holds typing no reload may overwrite.
  const [base, setBase] = useState(value)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The last save confirmed here: the value it wrote, and when, by the server's clock.
  const [lastSave, setLastSave] = useState<{ value: number; savedAt: number } | null>(null)
  const savedAt = lastSave?.savedAt ?? 0
  // Follow the server (#174): filled once, the field went on holding the value it was filled with
  // after the other phone saved a new one, and a Save without retyping sent the old value back over
  // it. Reloads are told apart by when they read, not by the value they bring. React's documented way
  // to adjust state when a prop changes.
  const [seen, setSeen] = useState(readAt)
  // Set by a refusal, to refill again from the page as it is: a reload that landed while the save was
  // in flight was held back, and nothing reloads after a refusal.
  const [reapply, setReapply] = useState(false)
  if (seen !== readAt || reapply) {
    setSeen(readAt)
    setReapply(false)
    // Only a read made after a save can hold the value it wrote, as in BudgetEditor (#176). With two
    // quick saves, the reload asked for after the first can read the value before the second writes
    // it and land after it is sent: refilled from it, the field would show the first value, for the
    // next Save to send back. So nothing is taken from the page while a save is in flight, when the
    // time of the write is not known yet, nor from a read made by then.
    const server = valueText(initialValue)
    if (!busy && readAt > savedAt) {
      // A field that holds the value the server has keeps it as it was written, and holds nothing
      // unsaved, even if it was typed: it becomes the base, so the field follows the server again.
      // Kept as typing after a save with an unknown outcome that landed, it never followed the other
      // phone again, and a Save without retyping sent it back over the other phone's value (#174).
      if (sameValue(value, server)) setBase(value)
      else if (value === base) {
        setValue(server)
        setBase(server)
      }
    }
  }
  // What "Currently" says is stored, after each outcome (#174): the page's value, unless the page
  // read it before the last save here was written; then it is the value that save wrote, dated when
  // it was written. Shown as read, the reload after the first of two quick saves said the first value
  // was current while the field held the second, saved after it.
  const stored =
    lastSave && readAt <= lastSave.savedAt
      ? { value: lastSave.value, updatedAt: new Date(lastSave.savedAt).toISOString() }
      : { value: initialValue, updatedAt }

  async function save(e: React.FormEvent) {
    e.preventDefault()
    // As on the button: Enter in the field submits the form too.
    if (busy) return
    const v = amount(value)
    if (!Number.isFinite(v) || v < 0) {
      setError('Enter your home value, e.g. 750000 or $750,000.')
      return
    }
    setBusy(true)
    setError(null)
    // What is sent becomes the field's base, so the reload refills it unless it is edited after. The
    // field is disabled while saving, so what is sent is what stays on screen.
    const sent = value
    const before = base
    setBase(sent)
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
        // From here on, a read made before this write carries the value it replaced.
        if (result.savedAt !== undefined) setLastSave({ value: v, savedAt: result.savedAt })
        reload = true
      } else if (result.outcome === 'refused') {
        // The route's own words: the environment guard's 409 is a misconfiguration, and "please try
        // again" is advice that can never succeed. What was typed stays, so trying again is one tap:
        // its base goes back to what it was before the save, so it counts as typing, which no reload
        // overwrites. The page is applied again, so a reload held back while this save was in flight
        // still reaches the field if nothing was typed into it.
        setBase(before)
        setReapply(true)
        setError(result.error)
      } else {
        // It may have saved. What was typed stays, since saving again sets the same value: its base
        // goes back as on a refusal, so a reload's other value does not replace it, and the reload's
        // "Currently" line shows what is stored. A reload that shows it landed makes it the base.
        console.error('[HomeValueCard] save failed', result.cause)
        setBase(before)
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
      {stored.value != null && (
        <p className="text-sm text-muted">
          Currently {money(stored.value)}
          {stored.updatedAt && ` · updated ${new Date(stored.updatedAt).toLocaleDateString()}`}
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
