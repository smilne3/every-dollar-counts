import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'

// Auto-cleanup only registers when vitest runs with globals; this suite does not.
afterEach(cleanup)

// jsdom does not implement showModal()/close() on <dialog>; stand them up so the
// component's open/close effect can run. Real modal behaviour (focus trap, Escape,
// backdrop) is the platform's job and is verified in the browser, not here.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function () {
    this.open = false
  }
})

// The regression this guards: the old inline confirm swapped "Delete" for "Confirm" in the
// SAME position, so a double-click deleted straight through it. The confirm action must only
// ever be reachable from inside the dialog.
describe('ConfirmDialog', () => {
  const props = {
    title: 'Delete “Food & Drink”?',
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
  }

  it('renders nothing visible until open', () => {
    render(<ConfirmDialog {...props} open={false} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows the consequence copy when open', () => {
    render(
      <ConfirmDialog {...props} open>
        <p>9 transactions will become Uncategorized.</p>
      </ConfirmDialog>
    )
    expect(screen.getByText(/9 transactions will become Uncategorized/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy()
  })

  it('fires onConfirm only from the dialog button, and onCancel from Cancel', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    render(<ConfirmDialog {...props} open onConfirm={onConfirm} onCancel={onCancel} />)

    screen.getByRole('button', { name: 'Cancel' }).click()
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()

    screen.getByRole('button', { name: 'Delete' }).click()
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('disables both actions while the request is in flight', () => {
    render(<ConfirmDialog {...props} open busy />)
    expect(screen.getByRole('button', { name: 'Delete' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: 'Cancel' }).hasAttribute('disabled')).toBe(true)
  })
})
