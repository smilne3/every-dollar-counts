'use client'

import { useRef, type ReactNode } from 'react'
import { Button } from './Button'
import { Dialog } from './Dialog'

// Confirmation for destructive actions.
//
// The important part is that the confirm button lands in the middle of the screen, NOT under the
// cursor that just clicked "Delete" — the previous inline swap put "Confirm" exactly where
// "Delete" had been, so a double-click deleted straight through it. Cancel takes focus on open, so
// a stray Enter cancels rather than destroys.
//
// The <dialog> mechanics live in Dialog; this is the destructive-action shape of them.
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
  const cancelRef = useRef<HTMLButtonElement>(null)

  return (
    <Dialog
      open={open}
      title={title}
      initialFocusRef={cancelRef}
      onCancel={onCancel}
      footer={
        <>
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
        </>
      }
    >
      {children && <div className="mt-2 space-y-1 text-sm text-muted">{children}</div>}
    </Dialog>
  )
}
