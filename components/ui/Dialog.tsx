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
  busy = false,
  onCancel,
}: {
  open: boolean
  title: ReactNode
  children?: ReactNode
  footer: ReactNode
  // What takes focus when the dialog opens. Destructive dialogs point this at Cancel so a stray
  // Enter does nothing; a form points it at the first field.
  initialFocusRef?: RefObject<HTMLElement | null>
  // Something inside is mid-flight and the dialog must not be dismissed out from under it. Only
  // the Escape/back route is the shell's business — a caller's own footer buttons are the caller's
  // to disable. Defaults to false, so every dialog that does not pass it behaves exactly as before.
  //
  // NOT the same switch as ConfirmDialog's own `busy`, which only greys out Cancel and Confirm and
  // is deliberately not forwarded here: BankList, CategoryManager and GoalsList all set it during
  // a delete, and forwarding it would silently take Escape away from three dialogs that have
  // always had it. Whether a destructive confirm should also hold Escape is a separate question
  // from this one, which is about children being unmounted underneath a request.
  busy?: boolean
  onCancel: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  // What had focus before the dialog took it. The platform normally remembers this for us; see
  // the close branch below for the one case where it cannot.
  const opener = useRef<HTMLElement | null>(null)
  // Where focus goes when a caller has no opinion. Without an initialFocusRef, showModal() itself
  // focuses the first focusable descendant in tree order — whatever happens to come first in
  // `children`, not the heading. On TransactionCard's sheet that is the CategoryPicker <select>,
  // and on Android Chrome merely focusing a <select> can pop its list open with no tap at all.
  // Focusing the heading instead is conventional modal practice and what screen readers expect: a
  // caller with no `initialFocusRef` gets somewhere inert rather than whatever its own markup
  // happens to put first.
  const titleRef = useRef<HTMLHeadingElement>(null)
  // Generated, not hardcoded: two dialogs mounted at once would otherwise share one element id and
  // the second would take its accessible name from the first one's heading.
  const titleId = useId()

  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) {
      // Read BEFORE showModal(), which moves focus into the dialog.
      opener.current = document.activeElement as HTMLElement | null
      d.showModal()
      const target = initialFocusRef?.current ?? titleRef.current
      target?.focus()
    } else if (!open && d.open) {
      const previous = opener.current
      opener.current = null
      d.close()
      // close() restores focus to the opener by itself, and where it does this is a no-op. It does
      // NOT when focus has already left the dialog — which is what happens when a caller unmounts
      // the dialog's contents in the same commit that closes it. TransactionCard does exactly that,
      // so that 200 closed sheets do not ship in every page's HTML, and since showModal() puts
      // focus on the first focusable child, that is the ordinary Escape path rather than a corner
      // of one. The platform's other route back is transient activation, which Escape does not
      // grant. Left alone, focus lands on <body> and the next Tab starts at the top of the page.
      const active = document.activeElement
      if ((active === null || active === document.body) && previous?.isConnected) previous.focus()
    }
  }, [open, initialFocusRef])

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(e) => {
        // Only OUR <dialog>. `cancel` does not bubble in the DOM, but React attaches it to each
        // <dialog> directly and then walks the fiber ancestor chain anyway (`accumulateTargetOnly`
        // is true only for scroll/scrollend). A Dialog mounted inside a Dialog — which is what
        // TransactionCard's sheet does with ReimbursableEditor — therefore closed BOTH on Escape
        // or the Android back gesture, dumping the user back to the list mid-edit. Cancel and Save
        // hid it, because those fire `close`, which no ancestor handles.
        if (e.target !== ref.current) return
        e.preventDefault() // let React own the open state instead of the DOM closing itself
        // preventDefault happens either way — swallowing the cancel without it would let the DOM
        // close the element while React still believes it is open. `busy` only withholds the
        // close itself: a caller that unmounts its children on close would otherwise unmount a
        // request mid-flight, and the setState carrying its failure would land on nothing.
        if (busy) return
        onCancel()
      }}
      className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-card border border-line bg-surface p-0 text-ink shadow-lg backdrop:bg-ink/40"
    >
      {/* text-left explicitly: a dialog opened from a right-aligned table cell inherits that cell's
          text-align straight through, which put the title, the sub-line and every field label
          against the right edge (#49). Where a dialog is opened from has nothing to do with how it
          should read, so the shell pins it rather than each caller remembering to. */}
      <div className="p-5 text-left">
        {/* tabIndex={-1}: focusable by script (so the effect above and the browser's own
            showModal() default-focus step can both land here) without joining Tab order — a
            heading is not a control, so a keyboard user tabbing through the dialog should still
            start at the first real one. */}
        <h2 ref={titleRef} tabIndex={-1} id={titleId} className="text-base font-semibold text-ink">
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
