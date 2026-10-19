import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react'
import { ReimbursableEditor } from '@/components/ReimbursableEditor'
import { SAVE_TIMEOUT_MS } from '@/lib/save-response'
import {
  answering,
  badGateway,
  neverSettles,
  offline,
  redirectedToLogin,
  refused,
  saved,
  useFakeSaveClock,
} from './helpers/save-replies'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
  refresh.mockClear()
})

// A spy, so a test can tell whether the page is told to reload.
const refresh = vi.hoisted(() => vi.fn())
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))

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
    const fetchMock = answering(saved)
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
    const fetchMock = answering(saved)
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
    const fetchMock = answering(saved)
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

  // Type 40 and a note, then press Save.
  function saveForty() {
    openEditor()
    fireEvent.change(screen.getByLabelText('How much is coming back?'), { target: { value: '40' } })
    fireEvent.change(screen.getByLabelText('Note (optional)'), { target: { value: 'Dave' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  }
  const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement
  const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement

  it('closes and reloads once the save lands', async () => {
    const onBusyChange = vi.fn()
    vi.stubGlobal('fetch', answering(saved))
    render(<ReimbursableEditor {...props} onBusyChange={onBusyChange} />)
    saveForty()
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(onBusyChange.mock.calls.map((c) => c[0])).toEqual([true, false])
  })

  // Only the route's own { ok: true } closes the dialog (#103). On anything else it stays open with
  // what was typed, so a retry is one tap, and says why. A refusal wrote nothing and needs no reload
  // unless it says this row is stale (404, 409); an unknown outcome may have written, so it reloads.
  it.each([
    ['a refusal', () => refused(400, 'Your bank removed that transaction. Refresh and try again.'), 'Your bank removed that transaction. Refresh and try again.', 0],
    ['a 404', () => refused(404, 'That transaction no longer exists. Refresh and try again.'), 'That transaction no longer exists. Refresh and try again.', 1],
    ['a 409', () => refused(409, 'This transaction just changed. Refresh and try again.'), 'This transaction just changed. Refresh and try again.', 1],
    ['a redirect to the login page', redirectedToLogin, 'Your session ended. Sign in again.', 0],
    // The #103 bug: any OK reply used to close the dialog as if saved.
    ['a 200 without ok: true', () => new Response('{}', { headers: { 'content-type': 'application/json' } }), 'That could not be saved.', 0],
    ['a gateway error page', badGateway, 'It may not have saved. Showing the latest.', 1],
  ])('after %s, stays open with what was typed, says why and stops being busy', async (_, reply, message, reloads) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const onBusyChange = vi.fn()
    vi.stubGlobal('fetch', answering(reply))
    render(<ReimbursableEditor {...props} onBusyChange={onBusyChange} />)
    saveForty()
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(message))
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(field('How much is coming back?').value).toBe('40')
    expect(field('Note (optional)').value).toBe('Dave')
    expect(button('Save').disabled).toBe(false)
    expect(refresh).toHaveBeenCalledTimes(reloads)
    expect(onBusyChange.mock.calls.map((c) => c[0])).toEqual([true, false])
  })

  it('says it may not have saved and reloads when the request fails in flight', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', offline())
    render(<ReimbursableEditor {...props} />)
    saveForty()
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe('It may not have saved. Showing the latest.')
    )
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(logged).toHaveBeenCalledWith('[ReimbursableEditor] save failed', expect.any(TypeError))
  })

  // #103: Save and Cancel stayed disabled, and the phone sheet shut, until the browser gave up.
  it('gives up on a request that never settles: says so, reloads and stops being busy', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    useFakeSaveClock()
    vi.stubGlobal('fetch', neverSettles())
    const onBusyChange = vi.fn()
    render(<ReimbursableEditor {...props} onBusyChange={onBusyChange} />)
    saveForty()
    expect(button('Save').disabled).toBe(true)
    expect(button('Cancel').disabled).toBe(true)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAVE_TIMEOUT_MS)
    })
    expect(screen.getByRole('alert').textContent).toBe('It may not have saved. Showing the latest.')
    expect(button('Save').disabled).toBe(false)
    expect(button('Cancel').disabled).toBe(false)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(onBusyChange.mock.calls.map((c) => c[0])).toEqual([true, false])
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

  // §7: a 44px minimum tap target. The trigger was `h-6 w-6` — 24x24, and once this stage raised
  // the 14px checkbox sitting beside it in the same phone sheet (TransactionCard.tsx:174) it became
  // the smallest control left there. Same treatment as that checkbox: the HIT AREA grows, the ink
  // does not, so the glyph still reads as a discreet `text-xs` mark rather than becoming a 44px
  // button. Asserted on the class string because jsdom computes no layout.
  it('gives the trigger a 44px hit area below md without enlarging the glyph', () => {
    render(<ReimbursableEditor {...props} />)
    const classes = screen
      .getByRole('button', { name: /partial reimbursable amount for Joe S Den/ })
      .className.split(/\s+/)
    expect(classes).toContain('min-h-[44px]')
    expect(classes).toContain('min-w-[44px]')
    // No bare 24px cap reaching the phone. Split on whitespace, or `md:h-6` would satisfy this.
    expect(classes).not.toContain('h-6')
    expect(classes).not.toContain('w-6')
    // The ink is untouched.
    expect(classes).toContain('text-xs')
  })

  // Desktop must not change: TransactionRow.tsx:113 puts this in a right-aligned cell where it has
  // always occupied exactly 24x24, so both minimums are released and the fixed size comes back.
  it('restores the trigger to exactly 24x24 at md', () => {
    render(<ReimbursableEditor {...props} />)
    const classes = screen
      .getByRole('button', { name: /partial reimbursable amount for Joe S Den/ })
      .className.split(/\s+/)
    expect(classes).toContain('md:h-6')
    expect(classes).toContain('md:w-6')
    expect(classes).toContain('md:min-h-0')
    expect(classes).toContain('md:min-w-0')
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
