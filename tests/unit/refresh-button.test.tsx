import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import { RefreshButton, REFRESH_TIMEOUT_MS } from '@/components/RefreshButton'
import { SAVE_TIMEOUT_MS } from '@/lib/save-response'
import {
  answering,
  badGateway,
  neverSettles,
  offline,
  redirectedToLogin,
  refused,
  replyWith,
  useFakeSaveClock,
} from './helpers/save-replies'

// Refresh (#119, #165). It trusted any reply: a signed-out press followed the redirect to the login
// page, the body read as {}, every count as 0, and the button said "Everything up to date" with
// nothing synced. And with nothing new it claimed everything was up to date, which is false exactly
// when Plaid is behind the bank. It had no timeout either.

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

// The route's answer (app/api/plaid/sync-transactions/route.ts).
const synced = (over: Record<string, unknown> = {}) =>
  replyWith({ ok: true, banks: 6, added: 0, modified: 0, removed: 0, brokenNow: 0, failed: 0, skipped: 0, problems: [], ...over })

const button = () => screen.getByRole('button', { name: /Refresh/ }) as HTMLButtonElement
const message = () => button().parentElement?.querySelector('span')
const MAY_NOT_HAVE_FINISHED = 'It may not have finished. Showing the latest.'

async function press() {
  fireEvent.click(button())
  await vi.waitFor(() => expect(button().disabled).toBe(false))
}

describe('RefreshButton', () => {
  it('asks the sync route to refresh, says how many new transactions came in, and reloads', async () => {
    const fetchMock = answering(() => synced({ added: 3, modified: 1 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<RefreshButton />)
    await press()
    expect(fetchMock.mock.calls[0][0]).toBe('/api/plaid/sync-transactions')
    expect(fetchMock.mock.calls[0][1]?.method).toBe('POST')
    expect(message()?.textContent).toBe('Updated 6 banks · 3 new')
    expect(message()?.className).toContain('text-muted')
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(button().textContent).toBe('Refresh')
  })

  // #119: the sync can only say what Plaid has. It also re-reads balances, and a modified row is not
  // a new one, so the words claim no more than that no new transactions came.
  it('with nothing new, says only that Plaid had no new transactions, never that everything is up to date', async () => {
    vi.stubGlobal('fetch', answering(() => synced({ modified: 2 })))
    render(<RefreshButton />)
    await press()
    expect(message()?.textContent).toBe('No new transactions from Plaid yet')
    expect(screen.queryByText(/up to date/i)).toBeNull()
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('says how many banks need attention', async () => {
    vi.stubGlobal('fetch', answering(() => synced({ added: 2, brokenNow: 1, skipped: 1 })))
    render(<RefreshButton />)
    await press()
    expect(message()?.textContent).toBe('Updated 4 of 6 banks — 2 need attention. See Settings.')
    expect(message()?.className).toContain('text-coral')
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  // The route's refusal, or the login page: nothing was synced, so nothing is reloaded.
  it.each([
    ["the route's refusal", () => refused(500, "Couldn't refresh. Please try again."), "Couldn't refresh. Please try again."],
    ['a redirect to the login page', redirectedToLogin, 'Your session ended. Sign in again.'],
  ])('after %s, says why and does not reload', async (_, reply, words) => {
    vi.stubGlobal('fetch', answering(reply))
    render(<RefreshButton />)
    await press()
    expect(message()?.textContent).toBe(words)
    expect(message()?.className).toContain('text-coral')
    expect(screen.queryByText(/No new transactions|Updated/)).toBeNull()
    expect(refresh).not.toHaveBeenCalled()
  })

  // Lost, or not the route's answer: the sync may still finish on the server. The last case is
  // #119's {}: every count missing, which read as nothing new.
  it.each([
    ['a gateway error page', () => answering(badGateway)],
    ['a request that fails in flight', () => offline()],
    ['an OK reply that is not the route’s answer', () => answering(() => replyWith({}))],
    ['ok: true without the counts', () => answering(() => replyWith({ ok: true }))],
    ['the counts without ok: true', () => answering(() => replyWith({ banks: 6, added: 0, brokenNow: 0, failed: 0, skipped: 0 }))],
  ])('after %s, says it may not have finished and reloads', async (_, fetchMock) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', fetchMock())
    render(<RefreshButton />)
    await press()
    expect(message()?.textContent).toBe(MAY_NOT_HAVE_FINISHED)
    expect(message()?.className).toContain('text-coral')
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  // Six banks synced one after another can outlast a save's 20 seconds, so Refresh waits longer, but
  // not forever.
  it('waits past a save’s timeout, then gives up at REFRESH_TIMEOUT_MS: says so, reloads and stops spinning', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    useFakeSaveClock()
    vi.stubGlobal('fetch', neverSettles())
    render(<RefreshButton />)
    fireEvent.click(button())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAVE_TIMEOUT_MS)
    })
    expect(button().disabled).toBe(true)
    expect(button().textContent).toBe('Refreshing…')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_TIMEOUT_MS - SAVE_TIMEOUT_MS - 1)
    })
    expect(button().disabled).toBe(true)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(message()?.textContent).toBe(MAY_NOT_HAVE_FINISHED)
    expect(button().disabled).toBe(false)
    expect(button().textContent).toBe('Refresh')
    expect(refresh).toHaveBeenCalledTimes(1)
  })
})
