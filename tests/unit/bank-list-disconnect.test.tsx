import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup, fireEvent, within, act } from '@testing-library/react'
import { BankList } from '@/components/BankList'
import { SAVE_TIMEOUT_MS } from '@/lib/save-response'
import {
  answering,
  badGateway,
  neverSettles,
  offline,
  redirectedToLogin,
  refused,
  saved,
  unanswered,
  useFakeSaveClock,
} from './helpers/save-replies'

// Disconnect (#165). It used to read any lost reply as a definite failure, "That bank was NOT
// disconnected. It is still connected at Plaid.", when the disconnect may have gone through. Now
// the route's own words, which say what is true at Plaid on each path, are shown as they stand,
// and a reply that was lost, timed out or could not be read says it may or may not have happened
// and reloads the list.

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
  refresh.mockClear()
})

// A spy, so a test can tell whether the list is told to reload.
const refresh = vi.hoisted(() => vi.fn())
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))

// jsdom has no showModal()/close() on <dialog> (see tests/unit/confirm-dialog.test.tsx).
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function () {
    this.open = false
  }
})

const items = [
  { id: 'item-1', institution_name: 'Capital One', status: 'ok', status_detail: null, products: ['transactions'], created_at: '2026-05-07' },
]

const MAY_HAVE = 'That bank may or may not have been disconnected. Showing the latest.'

const renderList = () => render(<BankList items={items} slotsUsed={6} lifetimeSlots={10} />)
// The <dialog> itself, open or not: once closed it leaves the accessibility tree, and its title
// falls back to "Disconnect this bank?".
const confirmDialog = () => document.querySelector('dialog') as HTMLDialogElement
// Dialog calls close() in an effect after the commit that shows the outcome, so under load that
// commit can be seen first.
const dialogCloses = () => vi.waitFor(() => expect(confirmDialog().open).toBe(false))
const confirmButton = () =>
  within(screen.getByRole('dialog', { name: 'Disconnect Capital One?' })).getByRole('button', { name: 'Disconnect' }) as HTMLButtonElement
function disconnectCapitalOne() {
  const row = screen.getByText('Capital One').closest('li') as HTMLElement
  fireEvent.click(within(row).getByRole('button', { name: 'Disconnect' }))
  fireEvent.click(confirmButton())
}

describe('BankList Disconnect', () => {
  it('sends the bank to the route, closes the dialog and reloads the list once it is disconnected', async () => {
    const fetchMock = answering(saved)
    vi.stubGlobal('fetch', fetchMock)
    renderList()
    disconnectCapitalOne()
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/plaid/remove-item')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body as string)).toEqual({ itemId: 'item-1' })
    await dialogCloses()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  // The route's message says what happened at Plaid, so it is shown as it stands. Nothing changed in
  // the list, so it is not reloaded.
  it.each([
    [
      'Plaid refused',
      () => refused(502, 'Plaid could not disconnect that bank just now. Nothing was changed — try again.'),
      'Plaid could not disconnect that bank just now. Nothing was changed — try again.',
    ],
    [
      'Plaid did not confirm it',
      () => refused(502, "Plaid didn't confirm it, so that bank may or may not be disconnected. Try again."),
      "Plaid didn't confirm it, so that bank may or may not be disconnected. Try again.",
    ],
    ['the session ended', redirectedToLogin, 'Your session ended. Sign in again.'],
  ])("after a refusal because %s, shows the route's words and does not reload", async (_, reply, message) => {
    vi.stubGlobal('fetch', answering(reply))
    renderList()
    disconnectCapitalOne()
    expect((await screen.findByRole('alert')).textContent).toBe(message)
    await dialogCloses()
    expect(refresh).not.toHaveBeenCalled()
  })

  // Already gone, from the other phone say: the list is stale, so show the latest under the message.
  it('reloads the list when the bank is already gone', async () => {
    vi.stubGlobal('fetch', answering(() => refused(404, "That bank isn't connected any more.")))
    renderList()
    disconnectCapitalOne()
    expect((await screen.findByRole('alert')).textContent).toBe("That bank isn't connected any more.")
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  // A gateway's page or a dropped connection can come after Plaid revoked the bank. "It is still
  // connected at Plaid" would be a guess, so it says it may or may not have happened, and reloads.
  it.each([
    ['a gateway error page', () => answering(badGateway)],
    ['a request that fails in flight', () => offline()],
    // The route's own answer when the database never answered its delete (#173).
    ["the route's word that the database never answered", () => answering(unanswered)],
  ])('after %s, says it may or may not have been disconnected, and reloads', async (_, fetchMock) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', fetchMock())
    renderList()
    disconnectCapitalOne()
    expect((await screen.findByRole('alert')).textContent).toBe(MAY_HAVE)
    expect(screen.queryByText(/still connected/)).toBeNull()
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('gives up on a request that never settles: says so, reloads and frees the dialog', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    useFakeSaveClock()
    vi.stubGlobal('fetch', neverSettles())
    renderList()
    disconnectCapitalOne()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAVE_TIMEOUT_MS - 1)
    })
    // Still in flight: the dialog stays, its buttons held.
    expect(confirmDialog().open).toBe(true)
    expect(confirmButton().disabled).toBe(true)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(screen.getByRole('alert').textContent).toBe(MAY_HAVE)
    expect(confirmDialog().open).toBe(false)
    expect(refresh).toHaveBeenCalledTimes(1)
    // Opened again, the dialog is usable: busy cleared.
    const row = screen.getByText('Capital One').closest('li') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: 'Disconnect' }))
    expect(confirmButton().disabled).toBe(false)
  })

  // A message from the last attempt must not stand beside the next one's outcome.
  it('clears the last message when another disconnect starts', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(refused(502, 'Plaid could not disconnect that bank just now. Nothing was changed — try again.')).mockResolvedValueOnce(saved())
    )
    renderList()
    disconnectCapitalOne()
    expect(await screen.findByRole('alert')).toBeTruthy()
    disconnectCapitalOne()
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
