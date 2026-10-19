'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { progress } from '@/lib/budget'
import { money } from '@/lib/format'
import { MAY_NOT_HAVE_SAVED, sendSave } from '@/lib/save-response'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { inputClass } from '@/components/ui/styles'

// The editor's text for each category's limit, from what the server holds: blank for no limit.
function limitsText(categoryNames: string[], limits: Record<string, number>) {
  const o: Record<string, string> = {}
  for (const c of categoryNames) o[c] = limits[c] ? String(limits[c]) : ''
  return o
}

export function BudgetEditor({
  categoryNames,
  initialLimits,
  spend,
}: {
  categoryNames: string[]
  initialLimits: Record<string, number>
  spend: Record<string, number>
}) {
  const router = useRouter()
  const serverLimits = limitsText(categoryNames, initialLimits)
  const [limits, setLimits] = useState(serverLimits)
  // Follow the server (#162). When a reload brings different limits, after a save or after one
  // that may not have saved, show them: seeded once, the editor kept showing what was typed
  // whatever the server held. React's documented way to adjust state when a prop changes, as in
  // CategoryPicker. Null forgets what was last shown, so the next render shows the server's limits.
  const serverKey = JSON.stringify(serverLimits)
  const [seen, setSeen] = useState<string | null>(serverKey)
  if (seen !== serverKey) {
    setSeen(serverKey)
    setLimits(serverLimits)
  }
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    setSaving(true)
    setSaved(false)
    setError(null)
    let reload = false
    try {
      const items = categoryNames.map((c) => ({ category: c, monthly_limit: Number(limits[c] || 0) }))
      // The shared rule (lib/save-response.ts): only the route's own { ok: true } is a save.
      const result = await sendSave('/api/budgets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
      })
      if (result.outcome === 'saved') {
        setSaved(true)
        reload = true
      } else if (result.outcome === 'refused') {
        // Nothing was written, or the message says which part was not. What was typed stays, so
        // trying again is one tap.
        setError(result.error)
      } else {
        // It may have saved, so the typed limits must not stand as if they were the server's. Go
        // back to the server's limits; the reload brings the latest.
        console.error('[BudgetEditor] save failed', result.cause)
        setError(MAY_NOT_HAVE_SAVED)
        setSeen(null)
        reload = true
      }
    } finally {
      // Never left on "Saving…".
      setSaving(false)
    }
    // Outside the try: a throw from refresh is not a failed save.
    if (reload) router.refresh()
  }

  return (
    <div className="space-y-4">
      <Card className="p-5">
        {categoryNames.map((c) => {
          const s = spend[c] ?? 0
          const lim = Number(limits[c] || 0)
          const { ratio, over } = progress(s, lim)
          const barColor =
            lim <= 0 ? 'bg-line' : over ? 'bg-coral' : ratio > 0.8 ? 'bg-amber' : 'bg-emerald'
          return (
            <div
              key={c}
              data-budget-row
              className="grid grid-cols-1 items-start gap-2 border-b border-line py-3 last:border-0 md:grid-cols-[1fr_auto_7rem] md:items-center md:gap-3"
            >
              <div className="min-w-0">
                <div className="text-sm font-medium text-ink">{c}</div>
                <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-line md:max-w-xs">
                  <div
                    className={`h-1.5 rounded-full ${barColor}`}
                    style={{ width: `${lim > 0 ? ratio * 100 : 0}%` }}
                  />
                </div>
              </div>
              <div
                className={`text-right text-sm tabular-nums ${lim > 0 && over ? 'text-coral' : 'text-muted'}`}
              >
                {money(s)} spent
              </div>
              <input
                type="number"
                min="0"
                step="1"
                placeholder="No limit"
                aria-label={`${c} monthly budget limit`}
                value={limits[c]}
                onChange={(e) => {
                  setLimits({ ...limits, [c]: e.target.value })
                  // "Saved." beside a limit typed since would be the #162 lie again.
                  setSaved(false)
                }}
                className={`${inputClass} w-full text-right md:w-28`}
              />
            </div>
          )
        })}
      </Card>
      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <Button onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save budgets'}
          </Button>
          {saved && !saving && <span className="text-sm text-emerald">Saved.</span>}
        </div>
        {error && (
          <p role="alert" className="text-sm text-coral">
            {error}
          </p>
        )}
      </div>
    </div>
  )
}
