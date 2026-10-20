import { describe, it, expect, vi, afterEach } from 'vitest'
import { readSaveResponse, sendRequest, sendSave, SAVE_TIMEOUT_MS, SESSION_ENDED, SAVE_FAILED } from '@/lib/save-response'
import {
  answering,
  badGateway,
  neverSettles,
  offline,
  redirectedToLogin,
  refused,
  replyWith,
  saved,
  useFakeSaveClock,
} from './helpers/save-replies'

// #28 spec §8.2's rule, shared by the rules card: a save counts only when the reply is OK, not
// redirected, and JSON with ok: true.
const res = (o: { ok?: boolean; status?: number; redirected?: boolean; json?: boolean; body?: unknown; bad?: boolean }) =>
  ({
    ok: o.ok ?? true,
    status: o.status ?? (o.ok === false ? 409 : 200),
    redirected: o.redirected ?? false,
    headers: new Headers(o.json === false ? { 'content-type': 'text/html' } : { 'content-type': 'application/json' }),
    json: async () => {
      if (o.bad) throw new SyntaxError('bad json')
      return o.body
    },
  }) as unknown as Response

describe('readSaveResponse', () => {
  it('accepts only a JSON ok: true', async () => {
    expect(await readSaveResponse(res({ body: { ok: true } }))).toEqual({ ok: true })
    expect(await readSaveResponse(res({ body: {} }))).toEqual({ ok: false, error: SAVE_FAILED, status: 200 })
  })
  it('reads a redirect, or an OK reply that is not JSON, as an ended session', async () => {
    expect(await readSaveResponse(res({ redirected: true, body: { ok: true } }))).toEqual({ ok: false, error: SESSION_ENDED, status: 200 })
    expect(await readSaveResponse(res({ json: false }))).toEqual({ ok: false, error: SESSION_ENDED, status: 200 })
  })
  it("shows the route's message on a refusal, with its status", async () => {
    expect(await readSaveResponse(res({ ok: false, status: 409, body: { error: 'This rule just changed. Refresh and try again.' } }))).toEqual({
      ok: false,
      error: 'This rule just changed. Refresh and try again.',
      status: 409,
    })
    expect(await readSaveResponse(res({ ok: false, status: 400, body: {} }))).toEqual({ ok: false, error: SAVE_FAILED, status: 400 })
  })
  // A 502, a 504 or an HTML 500 from in front of the route can come after the write committed.
  it('throws on a non-JSON failure, because it may have saved', async () => {
    await expect(readSaveResponse(res({ ok: false, status: 502, json: false }))).rejects.toThrow()
    await expect(readSaveResponse(res({ ok: false, status: 500, bad: true }))).rejects.toThrow()
  })
  it("throws when the route's own OK reply cannot be read, because it may have saved", async () => {
    await expect(readSaveResponse(res({ bad: true }))).rejects.toThrow('bad json')
  })
})

// The one way the browser sends a save (#103): readSaveResponse's rule, a timeout, and no throw. A
// request that fails in flight, times out, or gets a reply that cannot be read is 'unknown': it may
// have written, so the caller says so and reloads.
describe('sendSave', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('sends the request as given and reports a saved reply', async () => {
    const fetchMock = answering(saved)
    vi.stubGlobal('fetch', fetchMock)
    const init = { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{"id":"r1"}' }
    expect(await sendSave('/api/category-rules', init)).toEqual({ outcome: 'saved' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/category-rules')
    expect(fetchMock.mock.calls[0][1]).toMatchObject(init)
  })

  it("reports a refusal with the route's message and status", async () => {
    vi.stubGlobal('fetch', answering(() => refused(409, 'This rule just changed. Refresh and try again.')))
    expect(await sendSave('/api/category-rules', { method: 'PATCH' })).toEqual({
      outcome: 'refused',
      error: 'This rule just changed. Refresh and try again.',
      status: 409,
    })
  })

  it('reports a redirect to the login page as an ended session, not a save', async () => {
    vi.stubGlobal('fetch', answering(redirectedToLogin))
    expect(await sendSave('/api/budgets', { method: 'POST' })).toEqual({ outcome: 'refused', error: SESSION_ENDED, status: 200 })
  })

  it.each([
    ['a gateway error page', badGateway],
    ['an OK reply whose JSON is cut off', () => new Response('{"ok":tr', { headers: { 'content-type': 'application/json' } })],
  ])('reports %s as unknown, because the write may have landed', async (_, reply) => {
    vi.stubGlobal('fetch', answering(reply))
    const result = await sendSave('/api/budgets', { method: 'POST' })
    expect(result.outcome).toBe('unknown')
  })

  it('reports a request that fails in flight as unknown, with its cause', async () => {
    vi.stubGlobal('fetch', offline())
    expect(await sendSave('/api/budgets', { method: 'POST' })).toEqual({ outcome: 'unknown', cause: new TypeError('Failed to fetch') })
  })

  // Without a bound, a request on a dead connection holds its editor busy, and the phone sheet shut,
  // until the browser's own network timeout: minutes.
  it('gives up on a request that never settles once SAVE_TIMEOUT_MS has passed, as unknown', async () => {
    useFakeSaveClock()
    vi.stubGlobal('fetch', neverSettles())
    let result: unknown
    void sendSave('/api/budgets', { method: 'POST' }).then((r) => (result = r))
    await vi.advanceTimersByTimeAsync(SAVE_TIMEOUT_MS - 1)
    expect(result).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(result).toEqual({ outcome: 'unknown', cause: expect.objectContaining({ name: 'TimeoutError' }) })
  })
})

// sendSave's rules for a reply that carries data (#165): a link token, a sync's counts. #119's false
// "Everything up to date" was a signed-out Refresh whose login page read as an empty, successful sync.
describe('sendRequest', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it("sends the request as given, with a timeout, and hands back the route's JSON", async () => {
    const fetchMock = answering(() => replyWith({ link_token: 'link-sandbox-1' }))
    vi.stubGlobal('fetch', fetchMock)
    const init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"mode":"add"}' }
    expect(await sendRequest('/api/plaid/create-link-token', init, 20_000)).toEqual({
      outcome: 'answered',
      body: { link_token: 'link-sandbox-1' },
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/plaid/create-link-token')
    expect(fetchMock.mock.calls[0][1]).toMatchObject(init)
    expect(fetchMock.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal)
  })

  it("reports a refusal in the route's words, with its status", async () => {
    vi.stubGlobal('fetch', answering(() => refused(409, 'You have used all 10 of your Plaid bank connections.')))
    expect(await sendRequest('/api/plaid/create-link-token', { method: 'POST' }, 20_000)).toEqual({
      outcome: 'refused',
      error: 'You have used all 10 of your Plaid bank connections.',
      status: 409,
    })
  })

  // The login page answers 200, so without this a signed-out request reads as an answer.
  it('reports a redirect to the login page as an ended session, not an answer', async () => {
    vi.stubGlobal('fetch', answering(redirectedToLogin))
    expect(await sendRequest('/api/plaid/sync-transactions', { method: 'POST' }, 20_000)).toEqual({
      outcome: 'refused',
      error: SESSION_ENDED,
      status: 200,
    })
  })

  // Each rule on its own, as readSaveResponse has them: a redirect is never the route's answer, even
  // as JSON, and an OK reply that is not JSON is never the route's either.
  it.each([
    [
      'a redirected reply, even one that is JSON',
      () => {
        const res = replyWith({ link_token: 'link-sandbox-1' })
        Object.defineProperty(res, 'redirected', { value: true })
        return res
      },
    ],
    ['an OK reply that is a page, not JSON', () => new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } })],
  ])('reports %s as an ended session', async (_, reply) => {
    vi.stubGlobal('fetch', answering(reply))
    expect(await sendRequest('/api/plaid/create-link-token', { method: 'POST' }, 20_000)).toEqual({
      outcome: 'refused',
      error: SESSION_ENDED,
      status: 200,
    })
  })

  // Every refusal these routes give is { error } in words. A failure in any other shape came from in
  // front of the route, and can arrive after the work was done.
  it.each([
    ['a gateway error page', badGateway],
    ['a failure that is JSON but not the route’s words', () => replyWith({ message: 'FUNCTION_INVOCATION_TIMEOUT' }, 504)],
    ['an OK reply whose JSON is cut off', () => new Response('{"ok":tr', { headers: { 'content-type': 'application/json' } })],
    ['an OK reply that is JSON null', () => replyWith(null)],
    ['an OK reply that is a JSON number', () => replyWith(42)],
    ['an OK reply that is a JSON list', () => replyWith([1, 2])],
  ])('reports %s as unknown, because the work may have been done', async (_, reply) => {
    vi.stubGlobal('fetch', answering(reply))
    const result = await sendRequest('/api/plaid/exchange-public-token', { method: 'POST' }, 20_000)
    expect(result.outcome).toBe('unknown')
  })

  it('reports a request that fails in flight as unknown, with its cause', async () => {
    vi.stubGlobal('fetch', offline())
    expect(await sendRequest('/api/plaid/sync-transactions', { method: 'POST' }, 20_000)).toEqual({
      outcome: 'unknown',
      cause: new TypeError('Failed to fetch'),
    })
  })

  // The caller's bound, not a save's: a Refresh or a bank link may outlast SAVE_TIMEOUT_MS.
  it('gives up on a request that never settles at the timeout it was given, as unknown', async () => {
    useFakeSaveClock()
    vi.stubGlobal('fetch', neverSettles())
    let result: unknown
    void sendRequest('/api/plaid/sync-transactions', { method: 'POST' }, 60_000).then((r) => (result = r))
    await vi.advanceTimersByTimeAsync(SAVE_TIMEOUT_MS)
    expect(result).toBeUndefined()
    await vi.advanceTimersByTimeAsync(60_000 - SAVE_TIMEOUT_MS - 1)
    expect(result).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(result).toEqual({ outcome: 'unknown', cause: expect.objectContaining({ name: 'TimeoutError' }) })
  })
})
