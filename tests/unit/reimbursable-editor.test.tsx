import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { ReimbursableEditor } from '@/components/ReimbursableEditor'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }))

// jsdom does not implement showModal()/close() on <dialog>; stand them up so the open/close effect
// can run. Real modal behaviour (focus trap, Escape, backdrop) is the platform's job.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function () {
    this.open = false
  }
})

const props = {
  transactionId: 't1',
  amount: 100,
  reimbursableAmount: null as number | null,
  note: null as string | null,
  label: 'Joe S Den',
  date: '2026-08-29',
}

function openEditor() {
  fireEvent.click(screen.getByRole('button', { name: /partial reimbursable amount for Joe S Den/ }))
}

describe('ReimbursableEditor', () => {
  it('shows only its trigger until opened', () => {
    render(<ReimbursableEditor {...props} />)
    expect(screen.getByRole('button', { name: /Joe S Den/ })).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  // The regression this guards (#49): the form used to render in normal flow inside an 80px table
  // cell, where the question wrapped to four lines and the amount input was one character wide.
  // Living inside a <dialog> is what gives it width the column never had.
  it('renders the form inside a dialog, not in the row', () => {
    const { container } = render(<ReimbursableEditor {...props} />)
    openEditor()
    const dialog = container.querySelector('dialog')
    expect(dialog).not.toBeNull()
    expect(dialog!.querySelector('input[type="number"]')).not.toBeNull()
    expect(dialog!.querySelector('input[type="text"]')).not.toBeNull()
  })

  it('names the charge it is editing', () => {
    render(<ReimbursableEditor {...props} />)
    openEditor()
    expect(screen.getByRole('heading', { name: /Joe S Den/ })).toBeTruthy()
    expect(screen.getByText(/on 2026-08-29/)).toBeTruthy()
  })

  // A remove action on an unmarked charge is a control that does nothing.
  it('offers the remove action only when there is a mark to remove', () => {
    render(<ReimbursableEditor {...props} />)
    openEditor()
    expect(screen.queryByRole('button', { name: 'Not reimbursable' })).toBeNull()
    cleanup()

    render(<ReimbursableEditor {...props} reimbursableAmount={40} />)
    openEditor()
    expect(screen.getByRole('button', { name: 'Not reimbursable' })).toBeTruthy()
  })

  it('saves the typed amount and note', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }))
    vi.stubGlobal('fetch', fetchMock)
    render(<ReimbursableEditor {...props} />)
    openEditor()

    fireEvent.change(screen.getByLabelText('How much is coming back?'), { target: { value: '40' } })
    fireEvent.change(screen.getByLabelText('Note (optional)'), { target: { value: 'Dave' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)
    expect(body).toEqual({ transactionId: 't1', amount: 40, note: 'Dave' })
  })

  // Zero coming back is the same statement as no mark at all, so it must not be stored as a zero
  // mark the reader would then see as a partial.
  it('sends null rather than a zero mark', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }))
    vi.stubGlobal('fetch', fetchMock)
    render(<ReimbursableEditor {...props} />)
    openEditor()

    fireEvent.change(screen.getByLabelText('How much is coming back?'), { target: { value: '0' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)
    expect(body.amount).toBeNull()
    expect(body.note).toBeNull()
  })

  it('will not save an amount larger than the charge', () => {
    render(<ReimbursableEditor {...props} />)
    openEditor()
    fireEvent.change(screen.getByLabelText('How much is coming back?'), { target: { value: '250' } })
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true)
  })

  it('closes on Cancel without sending anything', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    render(<ReimbursableEditor {...props} />)
    openEditor()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  // Reopening must show what is stored, not the last thing typed and abandoned.
  it('re-seeds the fields from the server value when reopened', () => {
    render(<ReimbursableEditor {...props} reimbursableAmount={40} note="Dave" />)
    openEditor()
    fireEvent.change(screen.getByLabelText('How much is coming back?'), { target: { value: '99' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    openEditor()
    expect((screen.getByLabelText('How much is coming back?') as HTMLInputElement).value).toBe('40')
    expect((screen.getByLabelText('Note (optional)') as HTMLInputElement).value).toBe('Dave')
  })

  // The route rounds to 2dp, so 0.004 becomes nothing there. If the client still called it a mark
  // it would send a note alongside an amount that rounds away — leaving reimbursable_note set with
  // reimbursable_amount null, the orphaned state both this editor and the checkbox refuse to make.
  it('treats a sub-cent amount as no mark at all, note included', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }))
    vi.stubGlobal('fetch', fetchMock)
    render(<ReimbursableEditor {...props} reimbursableAmount={40} note="Dave" />)
    openEditor()

    fireEvent.change(screen.getByLabelText('How much is coming back?'), { target: { value: '0.004' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)
    expect(body.amount).toBeNull()
    expect(body.note).toBeNull()
  })

  it('says the limit rather than leaving a disabled Save unexplained', () => {
    render(<ReimbursableEditor {...props} />)
    openEditor()
    expect(screen.getByText(/Up to \$100\.00/)).toBeTruthy()
  })

  it('warns that removing the mark takes the note with it', () => {
    render(<ReimbursableEditor {...props} reimbursableAmount={40} note="Dave" />)
    openEditor()
    expect(screen.getByText(/also removes the note/)).toBeTruthy()
  })


  // Found only by looking at it: the trigger lives in a `text-right` cell, and text-align inherits
  // straight into the dialog — title, sub-line and both labels were flush right. Every test passed
  // and it looked wrong, so this pins the alignment the shell is responsible for.
  it('reads left-aligned even though its trigger sits in a right-aligned cell', () => {
    const { container } = render(
      <div className="text-right">
        <ReimbursableEditor {...props} />
      </div>
    )
    openEditor()
    expect(container.querySelector('dialog > div')!.className).toContain('text-left')
  })

})
