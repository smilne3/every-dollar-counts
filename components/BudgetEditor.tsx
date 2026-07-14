'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { progress } from '@/lib/budget'
import { money } from '@/lib/format'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { inputClass } from '@/components/ui/styles'

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
  const [limits, setLimits] = useState<Record<string, string>>(() => {
    const o: Record<string, string> = {}
    for (const c of categoryNames) o[c] = initialLimits[c] ? String(initialLimits[c]) : ''
    return o
  })
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  async function save() {
    setSaving(true)
    setSaved(false)
    const items = categoryNames.map((c) => ({ category: c, monthly_limit: Number(limits[c] || 0) }))
    await fetch('/api/budgets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }),
    })
    setSaving(false)
    setSaved(true)
    router.refresh()
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
              className="grid grid-cols-[1fr_auto_7rem] items-center gap-3 border-b border-line py-3 last:border-0"
            >
              <div className="min-w-0">
                <div className="text-sm font-medium text-ink">{c}</div>
                <div className="mt-1.5 h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-line">
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
                value={limits[c]}
                onChange={(e) => setLimits({ ...limits, [c]: e.target.value })}
                className={`${inputClass} w-28 text-right`}
              />
            </div>
          )
        })}
      </Card>
      <div className="flex items-center gap-3">
        <Button onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save budgets'}
        </Button>
        {saved && !saving && <span className="text-sm text-emerald">Saved.</span>}
      </div>
    </div>
  )
}
