'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { goalProgress } from '@/lib/goal'
import { money } from '@/lib/format'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { inputClass, labelClass } from '@/components/ui/styles'

type Goal = { id: string; name: string; target_amount: number; saved_amount: number }

export function GoalsList({ initialGoals }: { initialGoals: Goal[] }) {
  const router = useRouter()
  const [name, setName] = useState('')
  const [target, setTarget] = useState('')
  const [busy, setBusy] = useState(false)

  async function call(method: string, body: unknown) {
    setBusy(true)
    await fetch('/api/goals', {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    setBusy(false)
    router.refresh()
  }

  return (
    <div className="space-y-6">
      <Card className="p-5">
        <form
          className="flex max-w-xl flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            const n = name.trim()
            const t = Number(target)
            if (n && t > 0) {
              call('POST', { name: n, target_amount: t })
              setName('')
              setTarget('')
            }
          }}
        >
          <label className="flex min-w-[12rem] flex-1 flex-col gap-1.5">
            <span className={labelClass}>Goal</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Emergency fund"
              className={inputClass}
            />
          </label>
          <label className="flex w-32 flex-col gap-1.5">
            <span className={labelClass}>Target</span>
            <input
              type="number"
              min="1"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="3000"
              className={inputClass}
            />
          </label>
          <Button variant="primary" disabled={busy}>
            Add goal
          </Button>
        </form>
      </Card>

      {initialGoals.length === 0 ? (
        <p className="text-sm text-muted">No savings goals yet. Add one above.</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {initialGoals.map((g) => (
            <GoalCard
              key={g.id}
              goal={g}
              busy={busy}
              onSave={(saved) => call('PATCH', { id: g.id, saved_amount: saved })}
              onDelete={() => call('DELETE', { id: g.id })}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function GoalCard({
  goal,
  busy,
  onSave,
  onDelete,
}: {
  goal: Goal
  busy: boolean
  onSave: (saved: number) => void
  onDelete: () => void
}) {
  const [saved, setSaved] = useState(String(goal.saved_amount))
  const ratio = goalProgress(Number(saved || 0), goal.target_amount)
  const pct = Math.round(ratio * 100)
  const done = ratio >= 1
  const changed = Number(saved || 0) !== goal.saved_amount

  return (
    <Card className="p-5">
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0 truncate text-base font-semibold text-ink">{goal.name}</div>
        <div className="shrink-0 text-sm tabular-nums text-muted">{pct}%</div>
      </div>
      <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-line">
        <div
          className={`h-full rounded-full ${done ? 'bg-emerald-600' : 'bg-emerald'}`}
          style={{ width: `${ratio * 100}%` }}
        />
      </div>
      <div className="mt-2 text-sm tabular-nums text-muted">
        {money(Number(saved || 0))} of {money(goal.target_amount)}
        {done ? ' 🎉' : ''}
      </div>
      <div className="mt-4 flex items-center gap-2">
        <label className={labelClass}>Saved</label>
        <div className="w-28">
          <input
            type="number"
            min="0"
            value={saved}
            onChange={(e) => setSaved(e.target.value)}
            className={inputClass}
          />
        </div>
        <Button
          variant="secondary"
          size="sm"
          disabled={busy || !changed}
          onClick={() => onSave(Number(saved || 0))}
        >
          Update
        </Button>
        <Button
          variant="danger"
          size="sm"
          className="ml-auto"
          disabled={busy}
          onClick={onDelete}
        >
          Delete
        </Button>
      </div>
    </Card>
  )
}
