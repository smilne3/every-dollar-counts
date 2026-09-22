import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'
import { useState } from 'react'
import { render, cleanup, fireEvent } from '@testing-library/react'
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
