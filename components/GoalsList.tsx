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
// A goal's failure: what its card says, and what the list says instead if a reload no longer lists
// the goal. The second is worded as done, since by then the page has reloaded.
type GoalFailure = { message: string; gone: string }

// The list's words for a goal that a reload no longer lists, unless the route's 404 said it already.
const GONE = 'That goal no longer exists.'

export function GoalsList({ initialGoals }: { initialGoals: Goal[] }) {
  const router = useRouter()
  const [name, setName] = useState('')
  const [target, setTarget] = useState('')
  const [busy, setBusy] = useState(false)
  // Each failure stays where it was made, under the add form or on its goal, until that control's
  // next save. One failure for the whole list was cleared by any save, and a refused goal's card then
  // went on showing the amount typed, which the server did not have, with nothing to say so.
  const [addError, setAddError] = useState<string | null>(null)
  const [goalErrors, setGoalErrors] = useState<Record<string, GoalFailure>>({})
  // Failures of goals a reload no longer lists: their cards are gone and the messages with them, so
  // each is said once at the top of the list, until the next save.
  const [goneMessages, setGoneMessages] = useState<string[]>([])
  // React's documented way to adjust state when a prop changes. The goals change only on a reload.
  const [listed, setListed] = useState(initialGoals)
  if (listed !== initialGoals) {
    setListed(initialGoals)
    const ids = new Set(initialGoals.map((g) => g.id))
    const gone = Object.keys(goalErrors).filter((id) => !ids.has(id))
    if (gone.length > 0) {
      setGoneMessages((said) => [...new Set([...said, ...gone.map((id) => goalErrors[id].gone)])])
      setGoalErrors((all) => Object.fromEntries(Object.entries(all).filter(([id]) => ids.has(id))))
    }
  }

  // Sets, or with null clears, the failure of one control: the add form (goalId null) or a goal.
  function setFailure(goalId: string | null, failure: GoalFailure | null) {
    if (goalId === null) {
      setAddError(failure?.message ?? null)
      return
    }
    setGoalErrors((all) => {
      const next = { ...all }
      if (failure) next[goalId] = failure
      else delete next[goalId]
      return next
    })
  }

  // Add, update and delete all save through here (#165). Returns what happened, so the caller can
  // decide what becomes of what was typed.
  async function call(method: 'POST' | 'PATCH' | 'DELETE', body: unknown, goalId: string | null): Promise<Outcome> {
    setBusy(true)
    // Only this control's own failure goes; another's stays until its own next save.
    setFailure(goalId, null)
    setGoneMessages([])
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
        // 404: the goal is gone (deleted on the other phone), so the list is stale. Show the latest.
        // The route's 404 is worded as done, so the list can say it once the card has gone.
        setFailure(goalId, { message: result.error, gone: result.status === 404 ? result.error : GONE })
        reload = result.status === 404
      } else {
        console.error('[GoalsList] save failed', result.cause)
        setFailure(goalId, { message: MAY_NOT_HAVE_SAVED, gone: GONE })
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
        {addError && (
          <p role="alert" className="mt-3 text-sm text-coral">
            {addError}
          </p>
        )}
      </Card>

      {goneMessages.length > 0 && (
        <p role="alert" className="text-sm text-coral">
          {goneMessages.join(' ')}
        </p>
      )}

      {initialGoals.length === 0 ? (
        <p className="text-sm text-muted">No savings goals yet. Add one above.</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {initialGoals.map((g) => (
            <GoalCard
              key={g.id}
              goal={g}
              busy={busy}
              error={goalErrors[g.id]?.message ?? null}
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
