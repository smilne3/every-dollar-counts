'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { goalProgress } from '@/lib/goal'
import { money } from '@/lib/format'
import { MAY_NOT_HAVE_SAVED, sendSave, type SaveOutcome } from '@/lib/save-response'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { inputClass, labelClass } from '@/components/ui/styles'

type Goal = { id: string; name: string; target_amount: number; saved_amount: number }
type Outcome = SaveOutcome['outcome']

export function GoalsList({ initialGoals }: { initialGoals: Goal[] }) {
  const router = useRouter()
  const [name, setName] = useState('')
  const [target, setTarget] = useState('')
  const [busy, setBusy] = useState(false)
  // The last save's failure, shown where it was made: under the add form (goalId null) or on the
  // goal it was for.
  const [failure, setFailure] = useState<{ goalId: string | null; message: string } | null>(null)

  // Add, update and delete all save through here (#165). Returns what happened, so the caller can
  // decide what becomes of what was typed.
  async function call(method: 'POST' | 'PATCH' | 'DELETE', body: unknown, goalId: string | null): Promise<Outcome> {
    setBusy(true)
    setFailure(null)
    let reload = false
    let outcome: Outcome = 'unknown'
    try {
      // The shared rule (lib/save-response.ts): only the route's own { ok: true } is a save.
      const result = await sendSave('/api/goals', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      outcome = result.outcome
      if (result.outcome === 'saved') {
        reload = true
      } else if (result.outcome === 'refused') {
        setFailure({ goalId, message: result.error })
        // 404: the goal is gone (deleted on the other phone), so the list is stale. Show the latest.
        reload = result.status === 404
      } else {
        console.error('[GoalsList] save failed', result.cause)
        setFailure({ goalId, message: MAY_NOT_HAVE_SAVED })
        reload = true
      }
    } finally {
      // Never left with every goal control disabled.
      setBusy(false)
    }
    // Outside the try: a throw from refresh is not a failed save.
    if (reload) router.refresh()
    return outcome
  }

  return (
    <div className="space-y-6">
      <Card className="p-5">
        <form
          className="flex max-w-xl flex-col gap-3 md:flex-row md:flex-wrap md:items-end"
          onSubmit={async (e) => {
            e.preventDefault()
            // As on the button: Enter in either field submits the form too.
            if (busy) return
            const n = name.trim()
            const t = Number(target)
            if (n && t > 0) {
              // Cleared once it saved, not before the reply, so a refused add keeps what was typed.
              // Cleared too when it may have saved: an add is not a set, and a second Add of the same
              // goal could make two. The reload shows whether it landed.
              if ((await call('POST', { name: n, target_amount: t }, null)) !== 'refused') {
                setName('')
                setTarget('')
              }
            }
          }}
        >
          <label data-goal-name-field className="flex flex-1 flex-col gap-1.5 md:min-w-[12rem]">
            <span className={labelClass}>Goal</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Emergency fund"
              disabled={busy}
              className={inputClass}
            />
          </label>
          <label data-goal-target-field className="flex w-full flex-col gap-1.5 md:w-32">
            <span className={labelClass}>Target</span>
            <input
              type="number"
              min="1"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="3000"
              disabled={busy}
              className={inputClass}
            />
          </label>
          <Button variant="primary" disabled={busy}>
            Add goal
          </Button>
        </form>
        {failure && failure.goalId === null && (
          <p role="alert" className="mt-3 text-sm text-coral">
            {failure.message}
          </p>
        )}
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
              error={failure?.goalId === g.id ? failure.message : null}
              onSave={(saved) => call('PATCH', { id: g.id, saved_amount: saved }, g.id)}
              onDelete={() => void call('DELETE', { id: g.id }, g.id)}
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
  error,
  onSave,
  onDelete,
}: {
  goal: Goal
  busy: boolean
  error: string | null
  onSave: (saved: number) => Promise<Outcome>
  onDelete: () => void
}) {
  const [saved, setSaved] = useState(String(goal.saved_amount))
  // What the field was last filled with from the server, or last saved. A field that still holds it
  // has had nothing typed since, so a reload refills it with the amount stored; one typed into keeps
  // what was typed. Reloads are told apart by the goal's identity, not its amount, so one that brings
  // the same amount back still refills a field holding an amount the server does not have.
  // React's documented way to adjust state when a prop changes.
  const [base, setBase] = useState(saved)
  const [shown, setShown] = useState(goal)
  if (shown !== goal) {
    setShown(goal)
    if (saved === base) {
      setSaved(String(goal.saved_amount))
      setBase(String(goal.saved_amount))
    }
  }
  // Set after a save whose outcome is unknown, and acted on here so the field goes back to the amount
  // the page holds now, not the one it held when Update was tapped: the reload from an earlier save
  // can land while this one is in flight.
  const [resetting, setResetting] = useState(false)
  if (resetting) {
    setResetting(false)
    setSaved(String(goal.saved_amount))
    setBase(String(goal.saved_amount))
  }
  const [confirmDelete, setConfirmDelete] = useState(false)
  const ratio = goalProgress(Number(saved || 0), goal.target_amount)
  const pct = Math.round(ratio * 100)
  const done = ratio >= 1
  const changed = Number(saved || 0) !== goal.saved_amount

  async function update() {
    const sent = saved
    const outcome = await onSave(Number(sent || 0))
    if (outcome === 'saved') {
      // Now the server's, so the reload refills it with the amount as stored.
      setBase(sent)
    } else if (outcome === 'unknown') {
      // The bar and the figures follow the field, so an amount left in it would show progress the
      // server may not have. Back to the amount last read (see `resetting`); the reload shows the
      // latest.
      setResetting(true)
    }
    // A refusal wrote nothing: what was typed stays, for another try.
  }

  return (
    <Card data-goal-card className="p-5">
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
            aria-label={`Amount saved for ${goal.name}`}
            // Fixed while a save is in flight, so what was sent is what stays on screen.
            disabled={busy}
            className={inputClass}
          />
        </div>
        <Button
          variant="secondary"
          size="sm"
          disabled={busy || !changed}
          onClick={update}
        >
          Update
        </Button>
        <Button
          variant="danger"
          size="sm"
          className="ml-auto"
          disabled={busy}
          onClick={() => setConfirmDelete(true)}
          aria-label={`Delete ${goal.name}`}
        >
          Delete
        </Button>
      </div>
      {error && (
        <p role="alert" className="mt-3 text-sm text-coral">
          {error}
        </p>
      )}

      <ConfirmDialog
        open={confirmDelete}
        title={`Delete “${goal.name}”?`}
        busy={busy}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => {
          setConfirmDelete(false)
          onDelete()
        }}
      >
        <p>
          You’ve saved{' '}
          <strong className="font-semibold text-ink">{money(goal.saved_amount)}</strong> toward{' '}
          {money(goal.target_amount)}. This can’t be undone.
        </p>
      </ConfirmDialog>
    </Card>
  )
}
