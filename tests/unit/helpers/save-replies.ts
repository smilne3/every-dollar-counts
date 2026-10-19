import { vi } from 'vitest'

// The replies a save can get, for tests of anything that saves through lib/save-response.ts. Real
// Response objects, so what readSaveResponse reads (ok, status, redirected, the content type and
// the body) is what a browser's fetch would hand it. Each is a factory: a body can be read once.
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

export const saved = () => json(200, { ok: true })

// A refusal in the route's own words.
export const refused = (status: number, error: string) => json(status, { error })

// Signed out: proxy.ts redirects the request to /login, and fetch follows it to the login page's
// HTML, which answers 200.
export function redirectedToLogin() {
  const res = new Response('<!doctype html><title>Sign in</title>', {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })
  Object.defineProperty(res, 'redirected', { value: true })
  return res
}

// A gateway's error page from in front of the route. It can arrive after the write committed.
export const badGateway = () =>
  new Response('<html><body>502 Bad Gateway</body></html>', { status: 502, headers: { 'content-type': 'text/html' } })

// fetch stand-ins, typed as fetch is called so a test can read the url and init it was given.
type Fetch = (url: string, init?: RequestInit) => Promise<Response>
export const answering = (reply: () => Response) => vi.fn<Fetch>(async () => reply())
export const offline = () =>
  vi.fn<Fetch>(async () => {
    throw new TypeError('Failed to fetch')
  })
// A request on a dead connection: like a real fetch, it settles only when its signal aborts it.
export const neverSettles = () =>
  vi.fn<Fetch>(
    (_url, init) =>
      new Promise<Response>((_, reject) => {
        const signal = init?.signal
        signal?.addEventListener('abort', () => reject(signal.reason))
      })
  )

// jsdom runs AbortSignal.timeout on its own window timer, which vitest's fake clock does not reach
// (checked: advancing the fake clock past it leaves the signal unaborted). This gives
// AbortSignal.timeout the same behaviour on the faked setTimeout, so a test can move the clock past
// a save's timeout. Undo with vi.useRealTimers() and vi.restoreAllMocks().
export function useFakeSaveClock() {
  vi.useFakeTimers()
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(new DOMException('The operation timed out.', 'TimeoutError')), ms)
    return controller.signal
  })
}
