import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react'
import { ReimbursableCheckbox } from '@/components/ReimbursableCheckbox'
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
// A spy, so a test can tell whether the row is told to reload.
const refresh = vi.hoisted(() => vi.fn())
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))

const props = { transactionId: 't1', amount: 78, reimbursableAmount: null, label: 'Starbucks' }

describe('ReimbursableCheckbox', () => {
  it('is unticked when nothing is marked', () => {
    render(<ReimbursableCheckbox {...props} />)
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
  })

  it('is ticked when the whole transaction is marked', () => {
    render(<ReimbursableCheckbox {...props} reimbursableAmount={78} />)
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true)
  })

  // The column header is announced in table navigation but NOT when focus lands on the input, so
  // without this a screen reader hears "checkbox" down forty rows with nothing to tell them apart.
  it('names the row it belongs to', () => {
    render(<ReimbursableCheckbox {...props} />)
    expect(screen.getByRole('checkbox', { name: /Starbucks/ })).toBeTruthy()
  })

  // A partial mark is NOT a binary state. A ticked box beside "$750 of $1,000" would claim the whole
  // charge is coming back; an unticked one would claim none of it is. Both are lies, so it shows the
  // amount instead and sends the user to the editor.
  it('shows the marked amount rather than a box when only part is marked', () => {
    render(<ReimbursableCheckbox {...props} amount={1000} reimbursableAmount={750} />)
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.getByText(/750/)).toBeTruthy()
  })

  it('renders nothing on a credit-card payment', () => {
    const { container } = render(
      <ReimbursableCheckbox {...props} pfcDetailed="LOAN_PAYMENTS_CREDIT_CARD_PAYMENT" />
    )
    expect(container.firstChild).toBeNull()
  })

  // 0 would violate the DB CHECK's `reimbursable_amount > 0 or null`. Unticking must clear the mark
  // by sending `amount: null`, never `0` — this is the wire-level counterpart to
  // clampReimbursable's own null-not-zero contract in tests/unit/reimbursable-amount.test.ts.
  it('sends amount: null, not 0, when unticking a marked checkbox', async () => {
    const fetchMock = answering(saved)
    vi.stubGlobal('fetch', fetchMock)

    render(<ReimbursableCheckbox {...props} reimbursableAmount={78} />)
    const checkbox = screen.getByRole('checkbox') as HTMLInputElement
    expect(checkbox.checked).toBe(true)

    fireEvent.click(checkbox)

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/reimbursable')
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.amount).toBeNull()
  })

  // Clearing the mark must clear the memo too, or reimbursable_note stays set on a transaction whose
  // reimbursable_amount is null — data with nowhere it is shown, orphaned by the very action meant to
  // undo the mark.
  it('clears the note along with the amount when unticking', async () => {
    const fetchMock = answering(saved)
    vi.stubGlobal('fetch', fetchMock)

    render(<ReimbursableCheckbox {...props} reimbursableAmount={78} note="Dave" />)
    fireEvent.click(screen.getByRole('checkbox'))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [, init] = fetchMock.mock.calls[0]
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.note).toBeNull()
  })

  // Without optimistic state the box stayed bound to the server's value for the whole PATCH +
  // router.refresh() round trip: the browser toggled it, React snapped it straight back on the next
  // render, and it only settled once the refresh landed. That reads as a broken control (#50).
  it('ticks immediately, before the request comes back', () => {
    // A request that never resolves — so anything the box shows here is optimistic, by construction.
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    render(<ReimbursableCheckbox {...props} />)
    const box = screen.getByRole('checkbox') as HTMLInputElement
    expect(box.checked).toBe(false)
    fireEvent.click(box)
    expect(box.checked).toBe(true)
  })

  it('keeps the tick and reloads once the save lands', async () => {
    const onBusyChange = vi.fn()
    vi.stubGlobal('fetch', answering(saved))
    render(<ReimbursableCheckbox {...props} onBusyChange={onBusyChange} />)
    const box = screen.getByRole('checkbox') as HTMLInputElement
    fireEvent.click(box)
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
    expect(box.checked).toBe(true)
    expect(box.disabled).toBe(false)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(onBusyChange.mock.calls.map((c) => c[0])).toEqual([true, false])
  })

  // An optimistic tick that survives a failed save is a lie: it would show the charge as coming back
  // when nothing was saved. So every outcome but a save takes it back (#103). A refusal wrote
  // nothing and needs no reload, unless it says this row is stale (404, 409). An unknown outcome may
  // have written, so it reloads to show what the server has.
  it.each([
    ['a refusal', () => refused(400, 'Your bank removed that transaction. Refresh and try again.'), 'Your bank removed that transaction. Refresh and try again.', 0],
    ['a 404', () => refused(404, 'That transaction no longer exists. Refresh and try again.'), 'That transaction no longer exists. Refresh and try again.', 1],
    ['a 409', () => refused(409, 'This transaction just changed. Refresh and try again.'), 'This transaction just changed. Refresh and try again.', 1],
    ['a redirect to the login page', redirectedToLogin, 'Your session ended. Sign in again.', 0],
    // The #103 bug: any OK reply used to count as saved.
    ['a 200 without ok: true', () => new Response('{}', { headers: { 'content-type': 'application/json' } }), 'That could not be saved.', 0],
    ['a gateway error page', badGateway, 'It may not have saved. Showing the latest.', 1],
  ])('after %s, takes the tick back, says why and stops being busy', async (_, reply, message, reloads) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const onBusyChange = vi.fn()
    vi.stubGlobal('fetch', answering(reply))
    render(<ReimbursableCheckbox {...props} onBusyChange={onBusyChange} />)
    const box = screen.getByRole('checkbox') as HTMLInputElement
    fireEvent.click(box)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(message))
    expect(box.checked).toBe(false)
    expect(box.disabled).toBe(false)
    expect(refresh).toHaveBeenCalledTimes(reloads)
    expect(onBusyChange.mock.calls.map((c) => c[0])).toEqual([true, false])
  })

  it('says it may not have saved, takes the tick back and reloads when the request fails in flight', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', offline())
    render(<ReimbursableCheckbox {...props} />)
    const box = screen.getByRole('checkbox') as HTMLInputElement
    fireEvent.click(box)
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe('It may not have saved. Showing the latest.')
    )
    expect(box.checked).toBe(false)
    expect(box.disabled).toBe(false)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(logged).toHaveBeenCalledWith('[ReimbursableCheckbox] save failed', expect.any(TypeError))
  })

  // #103: the box stayed disabled, and the phone sheet shut, until the browser gave up.
  it('gives up on a request that never settles: says so, takes the tick back, reloads and stops being busy', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    useFakeSaveClock()
    vi.stubGlobal('fetch', neverSettles())
    const onBusyChange = vi.fn()
    render(<ReimbursableCheckbox {...props} onBusyChange={onBusyChange} />)
    const box = screen.getByRole('checkbox') as HTMLInputElement
    fireEvent.click(box)
    expect(box.disabled).toBe(true)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAVE_TIMEOUT_MS)
    })
    expect(screen.getByRole('alert').textContent).toBe('It may not have saved. Showing the latest.')
    expect(box.checked).toBe(false)
    expect(box.disabled).toBe(false)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(onBusyChange.mock.calls.map((c) => c[0])).toEqual([true, false])
  })


  // §7: a 44px minimum tap target on every form control. The box itself is 14x14 (`h-3.5 w-3.5`)
  // and its <label> holds no text to enlarge the hit area, so before this the whole target on a
  // phone was 14x14 — the smallest control in the app by a wide margin. The fix is on the hit area,
  // not the ink: the label gets the 44px minimum and centres the box inside it, so the box still
  // LOOKS 14px. Asserted on the class string because jsdom computes no layout.
  it('gives the checkbox a 44px hit area below md without resizing the box', () => {
    render(<ReimbursableCheckbox {...props} />)
    const box = screen.getByRole('checkbox')
    const label = box.closest('label') as HTMLElement
    expect(label.className).toContain('min-h-[44px]')
    expect(label.className).toContain('min-w-[44px]')
    // The ink is untouched — a 44px checkbox would be a different control, not a bigger target.
    expect(box.className).toContain('h-3.5')
    expect(box.className).toContain('w-3.5')
  })

  // Desktop must not change: the row's cell is right-aligned and the label has always been content
  // width there. Both minimums are released at `md`, and `md:justify-start` undoes the centring
  // that only the phone needs.
  it('releases the hit area at md so the desktop row is unchanged', () => {
    render(<ReimbursableCheckbox {...props} />)
    const label = screen.getByRole('checkbox').closest('label') as HTMLElement
    expect(label.className).toContain('md:min-h-0')
    expect(label.className).toContain('md:min-w-0')
    expect(label.className).toContain('md:justify-start')
  })

  // The optimistic tick must not outlive its click. The ⋮ editor writes the same field
  // through the same route, so without clearing on a prop change this box would keep claiming the
  // whole charge is coming back while the amount cell beside it showed a partial share (#50).
  it('drops the optimistic tick once the server value changes underneath it', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    const { rerender } = render(<ReimbursableCheckbox {...props} amount={100} />)
    fireEvent.click(screen.getByRole('checkbox'))
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true)

    // The editor saved a partial and the page refreshed: the prop now says 40 of 100.
    rerender(<ReimbursableCheckbox {...props} amount={100} reimbursableAmount={40} />)
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.getByText(/40/)).toBeTruthy()
  })

})
