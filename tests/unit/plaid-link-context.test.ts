import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { completePendingLink, EXCHANGE_TIMEOUT_MS, loadPendingLink, savePendingLink } from '@/components/plaid-link-context'
import { SAVE_TIMEOUT_MS, SESSION_ENDED } from '@/lib/save-response'
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

// completePendingLink (#165): the end of Link. For a new bank it sends the public-token exchange,
// which runs after Link has created the Item at Plaid and spent one of the ten connections (#51);
// for a reconnect, the reconnect. A reply that was lost, timed out or could not be read is
// 'unknown', which every caller words as "may have", never as a failure.

beforeEach(() => {
  useMemoryStorage()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const newBank = () => savePendingLink({ token: 'link-sandbox-1', mode: 'add', products: ['transactions'] })
const reconnecting = () => savePendingLink({ token: 'link-sandbox-update', mode: 'update', itemId: 'item-1' })
const finish = () => completePendingLink('public-sandbox-1', { institution: { name: 'Test Bank' } })

// The exchange route's own limit (maxDuration in app/api/plaid/exchange-public-token/route.ts).
// tests/unit/exchange-public-token-route.test.ts ties EXCHANGE_TIMEOUT_MS to it.
const ROUTE_LIMIT_MS = 300_000

describe('completePendingLink: a new bank', () => {
  it('sends the public token to the exchange, clears the pending link and reports it done', async () => {
    newBank()
    const fetchMock = answering(() => replyWith({ ok: true, added: 2, modified: 0, removed: 0 }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await finish()).toEqual({ outcome: 'done', warning: undefined })
    expect(fetchMock.mock.calls[0][0]).toBe('/api/plaid/exchange-public-token')
    expect(fetchMock.mock.calls[0][1]?.method).toBe('POST')
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string)).toEqual({
      public_token: 'public-sandbox-1',
      institution_name: 'Test Bank',
      products: ['transactions'],
    })
    expect(loadPendingLink()).toBeNull()
  })

  it('passes on the route’s warning when the bank connected but its data has not arrived', async () => {
    newBank()
    const warning = 'Bank connected, but its balances have not arrived yet. Press Refresh in a moment.'
    vi.stubGlobal('fetch', answering(() => replyWith({ ok: true, warning })))
    expect(await finish()).toEqual({ outcome: 'done', warning })
  })

  // Shown as the dashboard's notice: only words will do.
  it('passes on no warning that is not words', async () => {
    newBank()
    vi.stubGlobal('fetch', answering(() => replyWith({ ok: true, warning: { code: 'X' } })))
    expect(await finish()).toEqual({ outcome: 'done', warning: undefined })
  })

  // A definite refusal: the route said why, or the session had ended and it never ran. The pending
  // link stays, since the Item exists at Plaid.
  it.each([
    [
      "the route's refusal",
      () => refused(502, "Couldn't finish connecting that bank."),
      "Couldn't finish connecting that bank.",
    ],
    ['a redirect to the login page', redirectedToLogin, SESSION_ENDED],
  ])('after %s, reports it failed in those words and keeps the pending link', async (_, reply, words) => {
    newBank()
    vi.stubGlobal('fetch', answering(reply))
    expect(await finish()).toEqual({ outcome: 'failed', error: words })
    expect(loadPendingLink()).not.toBeNull()
  })

  // Any of these can come after the bank was linked and stored.
  it.each([
    ['a gateway error page', () => answering(badGateway)],
    ['a request that fails in flight', () => offline()],
    ['an OK reply that is not the route’s answer', () => answering(() => replyWith({}))],
  ])('after %s, reports it unknown, not failed, and keeps the pending link', async (_, fetchMock) => {
    newBank()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', fetchMock())
    expect(await finish()).toEqual({ outcome: 'unknown' })
    expect(loadPendingLink()).not.toBeNull()
  })

  // Giving up while the exchange could still be running, and calling it a failure, would invite a
  // second link: a duplicate, and a second connection spent (#51).
  it('waits past the exchange route’s own limit, then reports a stalled exchange unknown', async () => {
    newBank()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    useFakeSaveClock()
    vi.stubGlobal('fetch', neverSettles())
    let result: unknown
    void finish().then((r) => (result = r))
    await vi.advanceTimersByTimeAsync(SAVE_TIMEOUT_MS)
    expect(result).toBeUndefined()
    await vi.advanceTimersByTimeAsync(ROUTE_LIMIT_MS - SAVE_TIMEOUT_MS)
    expect(result).toBeUndefined()
    await vi.advanceTimersByTimeAsync(EXCHANGE_TIMEOUT_MS - ROUTE_LIMIT_MS - 1)
    expect(result).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(result).toEqual({ outcome: 'unknown' })
  })

  it('reports an attempt with nothing saved as failed, and sends nothing', async () => {
    const fetchMock = answering(() => replyWith({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await finish()).toEqual({ outcome: 'failed', error: 'That connection attempt expired. Please start again.' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('completePendingLink: a reconnect', () => {
  it('tells the reconnect route which bank, clears the pending link and reports it done', async () => {
    reconnecting()
    const fetchMock = answering(() => replyWith({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await completePendingLink('', { institution: null })).toEqual({ outcome: 'done', warning: undefined })
    expect(fetchMock.mock.calls[0][0]).toBe('/api/plaid/reconnect')
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string)).toEqual({ itemId: 'item-1' })
    expect(loadPendingLink()).toBeNull()
  })

  it.each([
    ["the route's refusal", () => refused(404, "That bank isn't connected any more."), "That bank isn't connected any more."],
    ['a redirect to the login page', redirectedToLogin, SESSION_ENDED],
  ])('after %s, reports it failed in those words', async (_, reply, words) => {
    reconnecting()
    vi.stubGlobal('fetch', answering(reply))
    expect(await completePendingLink('', { institution: null })).toEqual({ outcome: 'failed', error: words })
  })

  it.each([
    ['a gateway error page', () => answering(badGateway)],
    ['a request that fails in flight', () => offline()],
  ])('after %s, reports it unknown', async (_, fetchMock) => {
    reconnecting()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', fetchMock())
    expect(await completePendingLink('', { institution: null })).toEqual({ outcome: 'unknown' })
  })

  // Update mode makes no Item, so trying again is free: a save's bound is enough.
  it('gives up on a stalled reconnect once SAVE_TIMEOUT_MS has passed, as unknown', async () => {
    reconnecting()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    useFakeSaveClock()
    vi.stubGlobal('fetch', neverSettles())
    let result: unknown
    void completePendingLink('', { institution: null }).then((r) => (result = r))
    await vi.advanceTimersByTimeAsync(SAVE_TIMEOUT_MS - 1)
    expect(result).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(result).toEqual({ outcome: 'unknown' })
  })
})
