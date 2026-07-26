'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/Button'
import { inputClass } from '@/components/ui/styles'
import { money } from '@/lib/format'

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
    // Accept what Zillow shows verbatim — "$750,000" — by stripping $, commas, and spaces. The
    // card tells the user to copy from Zillow, so this must parse the way Zillow formats it.
    const v = Number(value.replace(/[$,\s]/g, ''))
    if (!Number.isFinite(v) || v < 0) {
      setError('Enter your home value, e.g. 750000 or $750,000.')
      return
    }
    setBusy(true)
    setError(null)
    const res = await fetch('/api/manual-assets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: v }),
    }).catch(() => null)
    setBusy(false)
    if (!res || !res.ok) {
      setError("Couldn't save that. Please try again.")
      return
    }
    router.refresh()
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
      {error && <p className="text-sm text-coral">{error}</p>}
    </form>
  )
}
