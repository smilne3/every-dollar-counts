'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { goalProgress } from '@/lib/goal'
import { money } from '@/lib/format'

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
      <form
        className="flex max-w-xl flex-wrap items-end gap-2 rounded border p-4"
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
        <label className="flex flex-1 flex-col text-sm">
          Goal
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Emergency fund"
            className="mt-1 rounded border p-2"
          />
        </label>
        <label className="flex flex-col text-sm">
          Target
          <input
            type="number"
            min="1"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder="3000"
            className="mt-1 w-28 rounded border p-2"
          />
        </label>
        <button disabled={busy} className="rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-50">
          Add goal
        </button>
      </form>

      {initialGoals.length === 0 ? (
        <p className="text-gray-600">No savings goals yet. Add one above.</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
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
    <div className="rounded border p-4">
      <div className="flex items-baseline justify-between">
        <div className="font-medium">{goal.name}</div>
        <div className="text-sm text-gray-500">{pct}%</div>
      </div>
      <div className="mt-2 h-2 w-full rounded bg-gray-200">
        <div
          className={`h-2 rounded ${done ? 'bg-green-600' : 'bg-green-500'}`}
          style={{ width: `${ratio * 100}%` }}
        />
      </div>
      <div className="mt-1 text-sm text-gray-600">
        {money(Number(saved || 0))} of {money(goal.target_amount)}
        {done ? ' 🎉' : ''}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <label className="text-xs text-gray-500">Saved</label>
        <input
          type="number"
          min="0"
          value={saved}
          onChange={(e) => setSaved(e.target.value)}
          className="w-28 rounded border p-1.5 text-sm"
        />
        <button
          disabled={busy || !changed}
          onClick={() => onSave(Number(saved || 0))}
          className="rounded border px-2 py-1 text-xs disabled:opacity-40"
        >
          Update
        </button>
        <button
          disabled={busy}
          onClick={onDelete}
          className="ml-auto rounded border px-2 py-1 text-xs text-red-600 disabled:opacity-40"
        >
          Delete
        </button>
      </div>
    </div>
  )
}
