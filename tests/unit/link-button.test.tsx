import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import { LinkButton } from '@/components/LinkButton'
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
