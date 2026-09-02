'use client'

import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react'

// The app's one overlay idiom, extracted from ConfirmDialog so a second modal cannot drift from
// the first. Uses the native <dialog>, so focus trapping, Escape and the backdrop come from the
// platform rather than from state we would have to maintain.
//
// Why a modal rather than a popover anchored to the control that opens it: the transactions table
// lives inside `overflow-x-auto` nested in a Card with `overflow-hidden`, so an absolutely
// positioned panel is clipped by two ancestors — worst on the narrow screens that need it most.
// Escaping that needs a portal, which this codebase has never had. The platform already gives us
// a correct overlay; this uses it.
//
// Deliberately NOT dismissable by backdrop click: the second click of a double-click on the
// control that opened it lands on the freshly-opened backdrop and would dismiss the dialog before
// it was read. Escape and the footer's own controls are the ways out.
export function Dialog({
  open,
  title,
  children,
  footer,
  initialFocusRef,
  onCancel,
}: {
  open: boolean
  title: ReactNode
  children?: ReactNode
  footer: ReactNode
  // What takes focus when the dialog opens. Destructive dialogs point this at Cancel so a stray
  // Enter does nothing; a form points it at the first field.
  initialFocusRef?: RefObject<HTMLElement | null>
  onCancel: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  // Generated, not hardcoded: two dialogs mounted at once would otherwise share one element id and
  // the second would take its accessible name from the first one's heading.
  const titleId = useId()

  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) {
      d.showModal()
      initialFocusRef?.current?.focus()
    } else if (!open && d.open) {
      d.close()
    }
  }, [open, initialFocusRef])

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault() // let React own the open state instead of the DOM closing itself
        onCancel()
      }}
      className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-card border border-line bg-surface p-0 text-ink shadow-lg backdrop:bg-ink/40"
    >
      <div className="p-5">
        <h2 id={titleId} className="text-base font-semibold text-ink">
          {title}
        </h2>
        {children}
        {/* justify-end with mr-auto on a leading child is how a destructive action sits apart from
            the confirming pair without the shell needing to know which buttons it was given. */}
        <div className="mt-5 flex items-center justify-end gap-2">{footer}</div>
      </div>
    </dialog>
  )
}
