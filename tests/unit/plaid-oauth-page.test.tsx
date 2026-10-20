import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import PlaidOAuthPage from '@/app/plaid/oauth/page'
import { savePendingLink } from '@/components/plaid-link-context'
import { answering, badGateway, offline, redirectedToLogin, refused, replyWith } from './helpers/save-replies'
import { useMemoryStorage } from './helpers/memory-storage'

// /plaid/oauth, where an OAuth bank (Wells Fargo, Chase…) returns the person (#165). Link resumes
// here and fires onSuccess, and the page finishes the link. Plaid Link cannot run here, so
// usePlaidLink is a stand-in that keeps the config it was given and is ready once it has a token.

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

const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => router }))

beforeEach(() => {
  useMemoryStorage()
  // What Connect a bank kept before handing off to the bank's own site.
  savePendingLink({ token: 'link-sandbox-1', mode: 'add', products: ['transactions'] })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  router.replace.mockClear()
  plaid.open.mockClear()
  plaid.config = null
})

const back = async () => {
  render(<PlaidOAuthPage />)
  await act(() => plaid.config!.onSuccess('public-sandbox-1', { institution: { name: 'Wells Fargo' } }))
}
const heading = () => screen.getByRole('heading', { level: 1 }).textContent
const CHECK_SETTINGS = /Check Settings before trying again — if the bank is listed there, it worked\./

describe('Plaid OAuth return page', () => {
  it('reopens Link with the token kept before the bank’s site', () => {
    render(<PlaidOAuthPage />)
    expect(plaid.config?.token).toBe('link-sandbox-1')
    expect(plaid.open).toHaveBeenCalledTimes(1)
  })

  it('goes to the dashboard once the bank is connected, carrying any warning', async () => {
    vi.stubGlobal('fetch', answering(() => replyWith({ ok: true, added: 0, modified: 0, removed: 0 })))
    await back()
    expect(router.replace).toHaveBeenCalledWith('/dashboard')
    cleanup()
    router.replace.mockClear()
    savePendingLink({ token: 'link-sandbox-1', mode: 'add', products: ['transactions'] })
    const warning = 'Bank connected, but its balances have not arrived yet. Press Refresh in a moment.'
    vi.stubGlobal('fetch', answering(() => replyWith({ ok: true, warning })))
    await back()
    expect(router.replace).toHaveBeenCalledWith(`/dashboard?notice=${encodeURIComponent(warning)}`)
  })

  it.each([
    [
      "the route's refusal",
      () => refused(502, "Couldn't finish connecting that bank. Check Settings before trying again."),
      "Couldn't finish connecting that bank. Check Settings before trying again.",
    ],
    ['a redirect to the login page', redirectedToLogin, 'Your session ended. Sign in again.'],
  ])('after %s, says it could not finish, and why', async (_, reply, words) => {
    vi.stubGlobal('fetch', answering(reply))
    await back()
    expect(heading()).toBe("We couldn't finish that connection")
    expect(screen.getByText(words)).toBeTruthy()
    expect(screen.getByText(CHECK_SETTINGS)).toBeTruthy()
    expect(router.replace).not.toHaveBeenCalled()
  })

  // These can come after the bank was linked and stored. "We couldn't finish" would send the person
  // to link it again: a duplicate, and a second connection spent (#51).
  it.each([
    ['a gateway error page', () => answering(badGateway)],
    ['a request that fails in flight', () => offline()],
  ])('after %s, says it could not confirm the connection, never that it failed', async (_, fetchMock) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', fetchMock())
    await back()
    expect(heading()).toBe("We couldn't confirm that connection")
    expect(screen.getByText('Your bank may be connected already.')).toBeTruthy()
    expect(screen.getByText(CHECK_SETTINGS)).toBeTruthy()
    expect(screen.queryByText(/couldn.t finish/i)).toBeNull()
    expect(router.replace).not.toHaveBeenCalled()
  })
})

// An OAuth bank's Reconnect returns here too: create-link-token sends the redirect URI in update mode.
// The bank is listed either way, and reconnecting again is free, so the new-link words would mislead:
// "if the bank is listed there, it worked" always reads as success, and the slot warning warns off a
// retry that costs nothing.
describe('Plaid OAuth return page, back from a Reconnect', () => {
  const CHECK_RECONNECT = 'Check Settings — if the bank no longer says “Connection lost”, it worked. Reconnecting again is free.'
  const SLOT_WARNING = /ten bank connections/

  beforeEach(() => {
    savePendingLink({ token: 'link-sandbox-update', mode: 'update', itemId: 'item-1' })
  })

  it('goes to the dashboard once the reconnect is recorded, carrying its warning', async () => {
    const warning = 'Reconnected. New transactions have not arrived yet — press Refresh in a moment.'
    const fetchMock = answering(() => replyWith({ ok: true, warning }))
    vi.stubGlobal('fetch', fetchMock)
    await back()
    expect(fetchMock.mock.calls[0][0]).toBe('/api/plaid/reconnect')
    expect(router.replace).toHaveBeenCalledWith(`/dashboard?notice=${encodeURIComponent(warning)}`)
  })

  it("after the route's refusal, says the reconnect could not finish, with no slot warning", async () => {
    vi.stubGlobal('fetch', answering(() => refused(500, "Couldn't finish reconnecting that bank. Please try again.")))
    await back()
    expect(heading()).toBe("We couldn't finish the reconnect")
    expect(screen.getByText("Couldn't finish reconnecting that bank. Please try again.")).toBeTruthy()
    expect(screen.getByText(CHECK_RECONNECT)).toBeTruthy()
    expect(screen.queryByText(SLOT_WARNING)).toBeNull()
    expect(router.replace).not.toHaveBeenCalled()
  })

  it.each([
    ['a gateway error page', () => answering(badGateway)],
    ['a request that fails in flight', () => offline()],
  ])('after %s, says the reconnect could not be confirmed, with no slot warning', async (_, fetchMock) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', fetchMock())
    await back()
    expect(heading()).toBe("We couldn't confirm the reconnect")
    expect(screen.getByText('Your bank may be reconnected already.')).toBeTruthy()
    expect(screen.getByText(CHECK_RECONNECT)).toBeTruthy()
    expect(screen.queryByText(SLOT_WARNING)).toBeNull()
    expect(router.replace).not.toHaveBeenCalled()
  })
})
