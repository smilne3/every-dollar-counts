import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import { ReconnectButton } from '@/components/ReconnectButton'
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

// Reconnect (#165): Link's update mode, which fixes a broken login without a new Item. Plaid Link
// itself cannot run here, so usePlaidLink is a stand-in that keeps the config it was given (to fire
// onSuccess as Link would) and is ready once it has a token.

type LinkConfig = {
  token: string | null
  onSuccess: () => Promise<void>
  onExit: (err: { display_message?: string | null } | null) => void
}
const plaid = vi.hoisted(() => ({ config: null as LinkConfig | null, open: vi.fn() }))
vi.mock('react-plaid-link', () => ({
  usePlaidLink: (config: LinkConfig) => {
    plaid.config = config
    return { open: plaid.open, ready: config.token !== null }
  },
}))

// A spy, so a test can tell whether the list is told to reload.
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
const NOT_STARTED = "Couldn't start the reconnection. Please try again."

describe('ReconnectButton: starting a reconnection', () => {
  it('asks for an update-mode link token for this bank, keeps it for the bank’s return, and opens Link', async () => {
    const fetchMock = answering(() => replyWith({ link_token: 'link-sandbox-update' }))
    vi.stubGlobal('fetch', fetchMock)
    render(<ReconnectButton itemId="item-1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    await vi.waitFor(() => expect(plaid.open).toHaveBeenCalledTimes(1))
    expect(fetchMock.mock.calls[0][0]).toBe('/api/plaid/create-link-token')
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string)).toEqual({ mode: 'update', itemId: 'item-1' })
    expect(pending()).toMatchObject({ token: 'link-sandbox-update', mode: 'update', itemId: 'item-1' })
  })

  // Link never opened, so nothing changed whatever the reply.
  it.each([
    ['a refusal', () => answering(() => refused(404, "That bank isn't connected any more.")), "That bank isn't connected any more."],
    ['a redirect to the login page', () => answering(redirectedToLogin), 'Your session ended. Sign in again.'],
    ['an OK reply with no link token', () => answering(() => replyWith({})), NOT_STARTED],
    ['a gateway error page', () => answering(badGateway), NOT_STARTED],
    ['a request that fails in flight', () => offline(), NOT_STARTED],
  ])('after %s, says why and opens nothing', async (_, fetchMock, words) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', fetchMock())
    render(<ReconnectButton itemId="item-1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    expect(await screen.findByText(words)).toBeTruthy()
    expect(plaid.open).not.toHaveBeenCalled()
    expect(pending()).toBeNull()
  })

  it('gives up on a link token that never comes once SAVE_TIMEOUT_MS has passed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    useFakeSaveClock()
    vi.stubGlobal('fetch', neverSettles())
    render(<ReconnectButton itemId="item-1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAVE_TIMEOUT_MS - 1)
    })
    expect(screen.queryByText(NOT_STARTED)).toBeNull()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(screen.getByText(NOT_STARTED)).toBeTruthy()
    expect(plaid.open).not.toHaveBeenCalled()
  })
})
