import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'
import { useState } from 'react'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { Dialog } from '@/components/ui/Dialog'

afterEach(cleanup)

// jsdom does not implement showModal()/close() on <dialog>, so Dialog's open effect cannot run
// without these. Same stand-ins as tests/unit/confirm-dialog.test.tsx:11-18.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function () {
    this.open = false
  }
})

function cancel(el: Element) {
  // `cancel` does not bubble in the DOM. React attaches it to each <dialog> directly and then
  // walks the FIBER ancestor chain anyway, which is the whole point of these tests.
  fireEvent(el, new Event('cancel', { bubbles: false, cancelable: true }))
}

describe('Dialog', () => {
  // Escape must route through React so React owns `open`, rather than the DOM closing the element
  // underneath it and leaving the two out of step.
  it('routes its own Escape through React instead of letting the DOM close itself', () => {
    const onCancel = vi.fn()
    const { container } = render(<Dialog open title="Sheet" onCancel={onCancel} footer={null} />)
    const evt = new Event('cancel', { bubbles: false, cancelable: true })
    container.querySelector('dialog')!.dispatchEvent(evt)
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(evt.defaultPrevented).toBe(true)
  })

  // TransactionCard passes no initialFocusRef, and showModal() natively focuses the first
  // focusable descendant — the CategoryPicker <select>. On Android Chrome, focusing a <select>
  // can pop its list open as a side effect of nothing more than showModal() running. A caller
  // that wants a specific target still gets it (see the "while busy" describe below and
  // ConfirmDialog's own test, which pins Cancel); a caller with no opinion gets the heading
  // instead of whatever happens to be first in the DOM.
  //
  // jsdom's showModal() stub (above) does not implement the browser's own default-focus step, so
  // this pins the shell's OWN fallback — the explicit .focus() Dialog runs after showModal() —
  // not the platform's. That is also why this asserts the heading itself has focus, rather than
  // merely that the select does not: nothing in jsdom would give the select focus in the first
  // place, so "not the select" would pass even with the old code that focuses nothing at all.
  it('focuses its own heading, not the first focusable child, when no initialFocusRef is given', () => {
    render(
      <Dialog open title="Loan Payments" onCancel={vi.fn()} footer={null}>
        <select aria-label="Category">
          <option>Loan Payments</option>
        </select>
      </Dialog>
    )
    const heading = screen.getByRole('heading', { name: 'Loan Payments' })
    expect(document.activeElement).toBe(heading)
    expect(document.activeElement).not.toBe(screen.getByRole('combobox'))
  })

  // `busy` is the shell's half of "a failed save must never be silently discarded". A caller that
  // unmounts its children on close — TransactionCard does — would otherwise unmount a request
  // mid-flight on Escape or the Android back gesture, and the setState carrying the failure would
  // land on an unmounted component, which React silently no-ops.
  //
  // It defaults to false: ConfirmDialog (BankList, CategoryManager, GoalsList) and
  // ReimbursableEditor pass nothing, and the test above is the proof that those are untouched.
  // ConfirmDialog's own `busy` is a different switch — it greys out Cancel and Confirm and is
  // deliberately not forwarded, so those three dialogs keep the Escape they have always had.
  describe('while busy', () => {
    it('withholds the cancel instead of dismissing a request mid-flight', () => {
      const onCancel = vi.fn()
      const { container } = render(
        <Dialog open busy title="Sheet" onCancel={onCancel} footer={null} />
      )
      const el = container.querySelector('dialog')!
      const evt = new Event('cancel', { bubbles: false, cancelable: true })
      el.dispatchEvent(evt)
      expect(onCancel).not.toHaveBeenCalled()
      // Still prevented: without this the DOM would close the element while React believes it is
      // open, which is a worse version of the same bug — invisible children, still mounted.
      expect(evt.defaultPrevented).toBe(true)
      expect(el.open).toBe(true)
    })
  })

  // A caller that unmounts the dialog's contents as it closes — TransactionCard does, so that 200
  // closed sheets do not ship in every page's HTML — drops focus to <body> in the same commit,
  // before close() runs. The platform then has nothing to restore from: its own bookkeeping only
  // fires while focus is still inside the dialog, and Escape grants no transient activation, which
  // is its other route back. showModal() focuses the first focusable child, so this is the ordinary
  // Escape path, not a corner of one.
  //
  // jsdom implements neither showModal()'s focus nor close()'s restoration (see the stand-ins
  // above), so what this pins is the shell's own fallback rather than the platform's.
  it('puts focus back on the opener when its contents unmount as it closes', () => {
    function Vanishing() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open
          </button>
          <Dialog open={open} title="Sheet" onCancel={() => setOpen(false)} footer={null}>
            {open && <input aria-label="Amount" />}
          </Dialog>
        </>
      )
    }
    const { container } = render(<Vanishing />)
    const opener = container.querySelector('button') as HTMLElement
    opener.focus()
    fireEvent.click(opener)

    // Stand in for showModal()'s own "focus the first focusable child", which jsdom does not do.
    const field = container.querySelector('input') as HTMLElement
    field.focus()
    expect(document.activeElement).toBe(field)

    cancel(container.querySelector('dialog') as Element)

    expect(container.querySelector('input')).toBeNull()
    expect(document.activeElement).toBe(opener)
  })

  // TransactionCard mounts ReimbursableEditor — itself a Dialog — INSIDE the sheet's Dialog, so
  // the editor's <dialog> is a fiber descendant of the sheet's. Native `cancel` does not bubble,
  // but React dispatches it up the fiber tree regardless (`accumulateTargetOnly` is true only for
  // scroll/scrollend). So Escape, or the Android back gesture, while setting a partial amount used
  // to close the editor AND the sheet, dumping the user back to the list. Cancel and Save were
  // unaffected because they fire `close`, which no ancestor handles — which is exactly why this
  // only showed up via the keyboard.
  describe('nested inside another Dialog', () => {
    function Nested({
      onSheetCancel,
      onEditorCancel,
    }: {
      onSheetCancel: () => void
      onEditorCancel: () => void
    }) {
      const [sheet, setSheet] = useState(true)
      const [editor, setEditor] = useState(true)
      return (
        <Dialog
          open={sheet}
          title="Sheet"
          onCancel={() => {
            setSheet(false)
            onSheetCancel()
          }}
          footer={null}
        >
          <Dialog
            open={editor}
            title="Editor"
            onCancel={() => {
              setEditor(false)
              onEditorCancel()
            }}
            footer={null}
          />
        </Dialog>
      )
    }

    it('closes only the nested dialog when the nested one is cancelled', () => {
      const onSheetCancel = vi.fn()
      const onEditorCancel = vi.fn()
      const { container } = render(
        <Nested onSheetCancel={onSheetCancel} onEditorCancel={onEditorCancel} />
      )
      const [sheet, editor] = Array.from(container.querySelectorAll('dialog'))
      expect(sheet.contains(editor)).toBe(true)
      expect(sheet.open).toBe(true)
      expect(editor.open).toBe(true)

      cancel(editor)

      expect(editor.open).toBe(false)
      expect(onEditorCancel).toHaveBeenCalledTimes(1)
      expect(sheet.open).toBe(true)
      expect(onSheetCancel).not.toHaveBeenCalled()
    })

    // The other direction still has to work: cancelling the outer dialog is the user asking for
    // the sheet itself to go away.
    it('still closes the outer dialog when the outer one is cancelled', () => {
      const onSheetCancel = vi.fn()
      const { container } = render(
        <Nested onSheetCancel={onSheetCancel} onEditorCancel={vi.fn()} />
      )
      const [sheet] = Array.from(container.querySelectorAll('dialog'))

      cancel(sheet)

      expect(onSheetCancel).toHaveBeenCalledTimes(1)
      expect(sheet.open).toBe(false)
    })
  })
})
