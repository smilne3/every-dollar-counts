'use client'

import { useEffect, useRef, type ReactNode } from 'react'
import { Button } from './Button'

// Confirmation for destructive actions.
//
// Uses the native <dialog> so focus trapping, Escape-to-close and the backdrop come
// from the platform. The important part is that the confirm button lands in the middle
// of the screen, NOT under the cursor that just clicked "Delete" — the previous inline
// swap put "Confirm" exactly where "Delete" had been, so a double-click deleted straight
// through it. Cancel takes focus on open, so a stray Enter cancels rather than destroys.
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel = 'Delete',
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean
  title: string
  children?: ReactNode
  confirmLabel?: string
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) {
      d.showModal()
      cancelRef.current?.focus()
    } else if (!open && d.open) {
      d.close()
    }
  }, [open])

  return (
    <dialog
      ref={ref}
      aria-labelledby="confirm-title"
      onCancel={(e) => {
        e.preventDefault() // let React own the open state instead of the DOM closing itself
        onCancel()
      }}
      // Deliberately NOT dismissable by backdrop click: the second click of a double-click
      // on "Delete" lands on the freshly-opened backdrop, which would dismiss the dialog
      // before it was ever read. Escape and Cancel are the ways out.
      className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-card border border-line bg-surface p-0 text-ink shadow-lg backdrop:bg-ink/40"
    >
      <div className="p-5">
        <h2 id="confirm-title" className="text-base font-semibold text-ink">
          {title}
        </h2>
        {children && <div className="mt-2 space-y-1 text-sm text-muted">{children}</div>}
        <div className="mt-5 flex justify-end gap-2">
          <Button
            ref={cancelRef}
            type="button"
            variant="secondary"
            size="sm"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button type="button" variant="danger" size="sm" onClick={onConfirm} disabled={busy}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </dialog>
  )
}
