'use client'

import { useId, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { money } from '@/lib/format'
import { inputClass, labelClass } from './ui/styles'
import { Button } from './ui/Button'
import { Dialog } from './ui/Dialog'

// Marking part of a charge as coming back. The tick box in the Reimbursable column handles the
// whole-charge case; this is for "£40 of this £100", plus the note saying who owes it.
//
// It opens in a dialog rather than inline. The form used to render in normal flow inside the row's
// 80px "More" cell (#49): the question wrapped across four lines, the amount input was about one
// character wide, and the note truncated to what you had typed first. A form needs width the
// column does not have, and the table's `overflow-x-auto` ancestor clips anything absolutely
// positioned, so the platform's modal is the honest container.
export function ReimbursableEditor({
  transactionId,
  amount,
  reimbursableAmount,
  note,
  label,
  date,
}: {
  transactionId: string
  amount: number
  reimbursableAmount: number | null
  note: string | null
  label: string
  date: string
}) {
  const router = useRouter()
  const full = Math.abs(amount)
  const marked = Number(reimbursableAmount ?? 0)

  const [open, setOpen] = useState(false)
  const [value, setValue] = useState(String(reimbursableAmount ?? ''))
  const [memo, setMemo] = useState(note ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const amountRef = useRef<HTMLInputElement>(null)
  const limitId = useId()

  function openEditor() {
    // Re-seed from what the server currently holds. The dialog can be opened again after a save or
    // a cancel, and leftover local state would show the last thing typed rather than what is stored.
    setValue(String(reimbursableAmount ?? ''))
    setMemo(note ?? '')
    setError(null)
    setOpen(true)
  }

  async function save(next: number | null) {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/reimbursable', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        // Clearing the amount clears the memo with it — the same rule ReimbursableCheckbox follows.
        // A note on an unmarked transaction is orphaned data with nowhere left to be shown.
        body: JSON.stringify({
          transactionId,
          amount: next,
          note: next === null ? null : memo,
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setError(body.error ?? 'That could not be saved.')
        return
      }
      setOpen(false)
      router.refresh()
    } catch {
      setError('That could not be saved.')
    } finally {
      setBusy(false)
    }
  }

  const typed = Number(value)
  const amountIsUsable = value.trim() !== '' && Number.isFinite(typed) && typed >= 0 && typed <= full
  // Round the way the route rounds (lib/reimbursements.ts clamps to 2dp) BEFORE deciding whether
  // this is really a clear. Without it 0.004 reads as a mark here and rounds to nothing there — the
  // amount comes back null while the note is written anyway, which is exactly the orphaned note
  // this file refuses to create.
  const rounded = Math.round(typed * 100) / 100

  return (
    <>
      <button
        type="button"
        onClick={openEditor}
        aria-label={`Set a partial reimbursable amount for ${label}`}
        className="inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-lg text-xs font-medium text-muted transition-colors hover:text-ink focus-visible:ring-2 focus-visible:ring-emerald/40 focus-visible:outline-none"
      >
        ⋮
      </button>

      <Dialog
        open={open}
        title={`Reimbursable — ${label}`}
        initialFocusRef={amountRef}
        onCancel={() => setOpen(false)}
        footer={
          <>
            {/* Only offered when there is a mark to remove, and named for the state it leaves
                behind. "Clear" beside Cancel and Save reads as "clear the form", and "Remove"
                sitting beside a transaction reads as deleting the transaction. */}
            {marked > 0 && (
              <Button
                type="button"
                variant="danger"
                size="sm"
                className="mr-auto"
                onClick={() => save(null)}
                disabled={busy}
              >
                Not reimbursable
              </Button>
            )}
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setOpen(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              // Typing 0 means the same thing as clearing it, so send null rather than a zero mark
              // the route would have to interpret.
              onClick={() => save(rounded === 0 ? null : rounded)}
              disabled={busy || !amountIsUsable}
            >
              Save
            </Button>
          </>
        }
      >
        <p className="mt-1 text-sm text-muted">
          {money(full)} on {date}
        </p>

        <div className="mt-4 space-y-3">
          <label className="block">
            <span className={labelClass}>How much is coming back?</span>
            <input
              ref={amountRef}
              type="number"
              step="0.01"
              min="0"
              max={full}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              aria-describedby={limitId}
              className={`${inputClass} mt-1`}
            />
          </label>
          {/* Outside the <label> on purpose: inside it, this text joins the field's accessible name
              and the label stops being the label. Save greys out above this limit and there is no
              <form>, so the browser's own max= message never fires — say it rather than leaving a
              dead button unexplained. */}
          <p id={limitId} className="-mt-2 text-xs text-faint">
            Up to {money(full)}
          </p>

          <label className="block">
            <span className={labelClass}>Note (optional)</span>
            <input
              type="text"
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              placeholder="Dave, Sam, Priya"
              className={`${inputClass} mt-1`}
            />
          </label>

          {marked > 0 && (note ?? '') !== '' && (
            <p className="text-xs text-faint">Marking it not reimbursable also removes the note.</p>
          )}

          {error && (
            <p role="alert" className="text-sm text-coral">
              {error}
            </p>
          )}
        </div>
      </Dialog>
    </>
  )
}
