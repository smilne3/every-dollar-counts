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

// The same limit however it is written: '' and '0' are both no limit, '150.50' and '150.5' one amount.
const sameLimit = (a: string | undefined, b: string | undefined) => Number(a || 0) === Number(b || 0)

// The fields of the categories the page lists, and no others. A field kept for a category deleted
// on the other phone would count as sent, with its old limit, if the category were added again.
function listedOnly(categoryNames: string[], fields: Record<string, string>) {
  const o: Record<string, string> = {}
  for (const c of categoryNames) if (Object.hasOwn(fields, c)) o[c] = fields[c]
  return o
}

export function BudgetEditor({
  categoryNames,
  initialLimits,
  readAt,
  spend,
}: {
  categoryNames: string[]
  initialLimits: Record<string, number>
  // When the page read initialLimits, by the server's clock (#176).
  readAt: number
  spend: Record<string, number>
}) {
  const router = useRouter()
  const [limits, setLimits] = useState(() => limitsText(categoryNames, initialLimits))
  // Each field's base: what it was last filled with from the server, or last sent. A field that
  // still equals its base holds nothing typed since; one that does not holds typing no reload may
  // overwrite.
  const [base, setBase] = useState(limits)
  const [saving, setSaving] = useState(false)
  // Whether "Saved." shows. null while a save is in flight and nothing beside it has changed; a
  // reload that fills a limit meanwhile sets it false, so the save's "Saved." does not claim it.
  const [saved, setSaved] = useState<boolean | null>(false)
  const [error, setError] = useState<string | null>(null)
  // When the last save confirmed here was written, by the server's clock: 0 until one is.
  const [savedAt, setSavedAt] = useState(0)
  // Follow the server (#162): each reload's limits refill the fields nobody has typed into since,
  // and leave the rest. Compared by identity, not content, because a reload that brings the same
  // limits back, after a save that did not land, must still refill what was sent but not stored.
  // React's documented way to adjust state when a prop changes.
  const [shown, setShown] = useState(initialLimits)
  // Set by a refusal, to refill again from the page as it is: a reload that landed while the save
  // was in flight held back every field it sent, and nothing reloads after a refusal (#176).
  const [reapply, setReapply] = useState(false)
  if (shown !== initialLimits || reapply) {
    setShown(initialLimits)
    setReapply(false)
    // Only a read made after a save can hold what it wrote (#176). With two quick saves, the reload
    // asked for after the first can read the limits before the second writes them and land after
    // the second is sent (in Next 16.4.2, while it is in flight). Refilled from it, the fields showed
    // the first save's limits beside "Saved.", and the next Save sent them back, undoing the second.
    // So a field holding what was sent is not refilled while its save is in flight, when the time of
    // the write is not known yet, nor from a read made by then.
    const current = !saving && readAt > savedAt
    const server = limitsText(categoryNames, initialLimits)
    const nextLimits = listedOnly(categoryNames, limits)
    const nextBase = listedOnly(categoryNames, base)
    let differs = false
    for (const c of categoryNames) {
      if (limits[c] !== base[c]) continue
      // A field with no base was never filled or sent here (a category added on the other phone),
      // so any read can fill it. Left blank, the next Save would clear the limit it has.
      if (!current && Object.hasOwn(base, c)) continue
      if (!sameLimit(limits[c], server[c])) differs = true
      nextLimits[c] = server[c]
      nextBase[c] = server[c]
    }
    setLimits(nextLimits)
    setBase(nextBase)
    // "Saved." only ever sits beside what was sent, so not beside other limits the reload brought.
    if (differs) setSaved(false)
  }

  async function save() {
    setSaved(null)
    setError(null)
    // min="0" does not stop a minus sign being typed, and a limit below zero would otherwise go to
    // the route, which refuses it. Said here, before anything is sent.
    if (categoryNames.some((c) => Number(limits[c] || 0) < 0)) {
      setError("Limits can't be negative.")
      return
    }
    setSaving(true)
    // What is sent becomes each field's base, so the reload refills it unless it is edited after.
    // The inputs are disabled while saving, so what is sent is what stays on screen.
    const sent = { ...limits }
    const before = base
    setBase(sent)
    let reload = false
    try {
      const items = categoryNames.map((c) => ({ category: c, monthly_limit: Number(sent[c] || 0) }))
      // The shared rule (lib/save-response.ts): only the route's own { ok: true } is a save.
      const result = await sendSave('/api/budgets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
      })
      if (result.outcome === 'saved') {
        // Unless a reload filled a limit while it was in flight: a category added on the other
        // phone, which this save did not send.
        setSaved((s) => s === null)
        // From here on, a read made before this write carries the limits it replaced.
        if (result.savedAt !== undefined) setSavedAt(result.savedAt)
        reload = true
      } else if (result.outcome === 'refused') {
        // Nothing was written, or the message says which part was not. What was typed stays, so
        // trying again is one tap. Its base goes back to what it was before the save, so it counts as
        // typing, which no reload overwrites: nothing reloads after a refusal, so the reload from an
        // earlier save can still land after it (#176). The page is then applied again, so a reload
        // held back while this save was in flight still reaches the fields nobody typed into.
        setBase((b) => ({ ...b, ...before }))
        setReapply(true)
        setError(result.error)
      } else {
        // It may have saved, and nothing is reset: with no connection the reload may never come,
        // and the old limits back on screen would be sent by the next Save, undoing a save that
        // may have landed. Saving again is safe, since a save sets every limit and adds nothing.
        // The reload, when it comes, refills every field not edited since.
        console.error('[BudgetEditor] save failed', result.cause)
        setError(MAY_NOT_HAVE_SAVED)
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
                value={limits[c] ?? ''}
                // Fixed while a save is in flight, so "Saved." sits beside exactly what was sent.
                disabled={saving}
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
