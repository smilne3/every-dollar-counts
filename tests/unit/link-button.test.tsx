import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import { LinkButton } from '@/components/LinkButton'
import { EXCHANGE_TIMEOUT_MS, savePendingLink } from '@/components/plaid-link-context'
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
import { useMemoryStorage } from './helpers/memory-storage'

// Connect a bank (#165). Plaid Link itself cannot run here, so usePlaidLink is a stand-in that
// keeps the config it was given (to fire onSuccess as Link would) and is ready once it has a token.

type LinkConfig = {
  token: string | null
  onSuccess: (publicToken: string, metadata: { institution?: { name?: string } | null }) => Promise<void>
  onExit: (err: { display_message?: string | null } | null) => void
}
const plaid = vi.hoisted(() => ({ config: null as LinkConfig | null, open: vi.fn() }))
vi.mock('react-plaid-link', () => ({
  usePlaidLink: (config: LinkConfig) => {
    plaid.config = config
    return { open: plaid.open, ready: config.token !== null }
  },
}))

// A spy, so a test can tell whether the page is told to reload.
const refresh = vi.hoisted(() => vi.fn())
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))

let storage: Storage
beforeEach(() => {
  storage = useMemoryStorage()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
  refresh.mockClear()
  plaid.open.mockClear()
  plaid.config = null
})

// What Link's return reads (components/plaid-link-context.ts).
const pending = () => JSON.parse(storage.getItem('plaid_pending_link') ?? 'null')
const SLOT_WARNING = /every new attempt uses one of your ten bank connections/
const NOT_STARTED = "Couldn't start the connection. Please try again."

describe('LinkButton: starting a connection', () => {
  it.each([
    ['Connect a bank', ['transactions']],
    ['Add investment account', ['investments']],
  ])('%s asks for a link token, keeps it for the bank’s return, and opens Link', async (name, products) => {
    const fetchMock = answering(() => replyWith({ link_token: 'link-sandbox-1' }))
    vi.stubGlobal('fetch', fetchMock)
    render(<LinkButton />)
    fireEvent.click(screen.getByRole('button', { name }))
    await vi.waitFor(() => expect(plaid.open).toHaveBeenCalledTimes(1))
    expect(fetchMock.mock.calls[0][0]).toBe('/api/plaid/create-link-token')
    expect(fetchMock.mock.calls[0][1]?.method).toBe('POST')
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string)).toEqual({ mode: 'add', products })
    expect(pending()).toMatchObject({ token: 'link-sandbox-1', mode: 'add', products })
  })

  // Link never opened, so nothing was connected and no slot was spent, whatever the reply. The slot
  // warning would scare the person off a retry that is free.
  it.each([
    [
      'a refusal',
      () => answering(() => refused(409, 'You have used all 10 of your Plaid bank connections. Disconnecting one does not free a slot.')),
      'You have used all 10 of your Plaid bank connections. Disconnecting one does not free a slot.',
    ],
    ['a redirect to the login page', () => answering(redirectedToLogin), 'Your session ended. Sign in again.'],
    ['an OK reply with no link token', () => answering(() => replyWith({})), NOT_STARTED],
    ['a gateway error page', () => answering(badGateway), NOT_STARTED],
    ['a request that fails in flight', () => offline(), NOT_STARTED],
  ])('after %s, says why, opens nothing and gives no slot warning', async (_, fetchMock, words) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', fetchMock())
    render(<LinkButton />)
    fireEvent.click(screen.getByRole('button', { name: 'Connect a bank' }))
    expect(await screen.findByText(words)).toBeTruthy()
    expect(screen.queryByText(SLOT_WARNING)).toBeNull()
    expect(plaid.open).not.toHaveBeenCalled()
    expect(pending()).toBeNull()
  })

  it('gives up on a link token that never comes once SAVE_TIMEOUT_MS has passed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    useFakeSaveClock()
    vi.stubGlobal('fetch', neverSettles())
    render(<LinkButton />)
    fireEvent.click(screen.getByRole('button', { name: 'Connect a bank' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAVE_TIMEOUT_MS - 1)
    })
    expect(screen.queryByText(NOT_STARTED)).toBeNull()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(screen.getByText(NOT_STARTED)).toBeTruthy()
    expect(screen.queryByText(SLOT_WARNING)).toBeNull()
    expect(plaid.open).not.toHaveBeenCalled()
  })
})

// Link fires onSuccess once the bank is linked at Plaid: the Item exists and a connection is spent
// (#51). What the person is told next decides whether they link it a second time.
describe('LinkButton: finishing a connection', () => {
  // True wherever the button is: the dashboard has no bank list above it.
  const SLOT_SUFFIX =
    ' Check your banks in Settings before trying again — every new attempt uses one of your ten bank connections permanently.'
  const MAY_HAVE_CONNECTED = 'That bank may have connected. Showing the latest.'
  const errorLine = () => document.querySelector('p.text-coral')?.textContent ?? null
  const connectButton = () => screen.getByRole('button', { name: /Connect a bank|Connecting…/ }) as HTMLButtonElement

  // Renders, keeps what start() would before Link opens, and returns what Link does on success.
  function linked() {
    render(<LinkButton />)
    savePendingLink({ token: 'link-sandbox-1', mode: 'add', products: ['transactions'] })
    return () => plaid.config!.onSuccess('public-sandbox-1', { institution: { name: 'Test Bank' } })
  }

  it('reloads once the bank is connected, with nothing to warn about', async () => {
    const fetchMock = answering(() => replyWith({ ok: true, added: 2, modified: 0, removed: 0 }))
    vi.stubGlobal('fetch', fetchMock)
    await act(linked())
    expect(fetchMock.mock.calls[0][0]).toBe('/api/plaid/exchange-public-token')
    expect(errorLine()).toBeNull()
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(connectButton().disabled).toBe(false)
  })

  it('shows the route’s warning when the bank connected but its data has not arrived', async () => {
    const warning = 'Bank connected, but its balances have not arrived yet. Press Refresh in a moment.'
    vi.stubGlobal('fetch', answering(() => replyWith({ ok: true, warning })))
    await act(linked())
    expect(screen.getByText(warning)).toBeTruthy()
    expect(errorLine()).toBeNull()
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  // A definite failure, said loudly with the slot warning: the connection is spent.
  it.each([
    [
      "the route's refusal",
      () => refused(502, "Couldn't finish connecting that bank."),
      "Couldn't finish connecting that bank.",
    ],
    ['a redirect to the login page', redirectedToLogin, 'Your session ended. Sign in again.'],
  ])('after %s, says why with the slot warning, and does not reload', async (_, reply, words) => {
    vi.stubGlobal('fetch', answering(reply))
    await act(linked())
    expect(errorLine()).toBe(words + SLOT_SUFFIX)
    expect(refresh).not.toHaveBeenCalled()
    expect(connectButton().disabled).toBe(false)
  })

  // These can come after the bank was linked and stored: saying it failed would invite a duplicate.
  it.each([
    ['a gateway error page', () => answering(badGateway)],
    ['a request that fails in flight', () => offline()],
  ])('after %s, says the bank may have connected, never that it failed, and reloads', async (_, fetchMock) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', fetchMock())
    await act(linked())
    expect(errorLine()).toBe(MAY_HAVE_CONNECTED + SLOT_SUFFIX)
    expect(screen.queryByText(/couldn.t|failed|not connected/i)).toBeNull()
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(connectButton().disabled).toBe(false)
  })

  it('stays on "Connecting…" past the exchange route’s own limit, then says the bank may have connected', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    useFakeSaveClock()
    vi.stubGlobal('fetch', neverSettles())
    const onSuccess = linked()
    act(() => void onSuccess())
    // The route's maxDuration (app/api/plaid/exchange-public-token/route.ts): it may still be running.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300_000)
    })
    expect(connectButton().textContent).toContain('Connecting…')
    expect(connectButton().disabled).toBe(true)
    expect(errorLine()).toBeNull()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(EXCHANGE_TIMEOUT_MS - 300_000)
    })
    expect(errorLine()).toBe(MAY_HAVE_CONNECTED + SLOT_SUFFIX)
    expect(connectButton().disabled).toBe(false)
    expect(refresh).toHaveBeenCalledTimes(1)
  })
})
