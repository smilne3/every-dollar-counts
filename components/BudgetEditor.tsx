'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { CATEGORIES, label } from '@/lib/categories'
import { NON_SPENDING, progress } from '@/lib/budget'
import { money } from '@/lib/format'

export function BudgetEditor({
  initialLimits,
  spend,
}: {
  initialLimits: Record<string, number>
  spend: Record<string, number>
}) {
  const router = useRouter()
  const cats = CATEGORIES.filter((c) => !NON_SPENDING.has(c))
  const [limits, setLimits] = useState<Record<string, string>>(() => {
    const o: Record<string, string> = {}
    for (const c of cats) o[c] = initialLimits[c] ? String(initialLimits[c]) : ''
    return o
  })
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  async function save() {
    setSaving(true)
    setSaved(false)
    const items = cats.map((c) => ({ category: c, monthly_limit: Number(limits[c] || 0) }))
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
    <div className="space-y-3">
      <div>
        {cats.map((c) => {
          const s = spend[c] ?? 0
          const lim = Number(limits[c] || 0)
          const { ratio, over } = progress(s, lim)
          const barColor =
            lim <= 0 ? 'bg-gray-300' : over ? 'bg-red-500' : ratio > 0.8 ? 'bg-amber-500' : 'bg-green-500'
          return (
            <div
              key={c}
              className="grid grid-cols-[1fr_auto_110px] items-center gap-3 border-b py-2"
            >
              <div className="min-w-0">
                <div className="text-sm font-medium">{label(c)}</div>
                <div className="mt-1 h-1.5 w-full max-w-xs rounded bg-gray-200">
                  <div
                    className={`h-1.5 rounded ${barColor}`}
                    style={{ width: `${lim > 0 ? ratio * 100 : 0}%` }}
                  />
                </div>
              </div>
              <div
                className={`text-right text-sm tabular-nums ${lim > 0 && over ? 'text-red-600' : 'text-gray-500'}`}
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
                className="w-full rounded border p-1.5 text-right text-sm"
              />
            </div>
          )
        })}
      </div>
      <div className="flex items-center gap-3">
        <button
          onClick={save}
          disabled={saving}
          className="rounded bg-black px-4 py-2 text-white disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save budgets'}
        </button>
        {saved && !saving && <span className="text-sm text-green-700">Saved.</span>}
      </div>
    </div>
  )
}
