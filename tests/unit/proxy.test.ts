// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// proxy() itself: the login gate in front of every page and /api route. Its matcher has its own
// test, tests/unit/proxy-pwa-paths.test.ts.
//
// #143: a check Supabase Auth could not answer was read as signed out, so a brief outage sent the
// whole household to the login screen, and every save in flight came back "Your session ended".
//
// The stand-in is strict: createServerClient hands back a client with getUser and nothing else, and
// getUser answers as supabase-js does, a user and no error or no user and the error, in auth-js's
// own error classes. It can write cookies first, through the setAll the proxy passed in, as a check
// that refreshed the session before it failed does.
type CookieWrite = { name: string; value: string; options: Record<string, unknown> }
const { getUser, setAll } = vi.hoisted(() => ({
  getUser: vi.fn(),
  setAll: { current: (() => {}) as (list: CookieWrite[]) => void },
}))
vi.mock('@supabase/ssr', () => ({
  createServerClient: (_url: string, _key: string, options: { cookies: { setAll: (list: CookieWrite[]) => void } }) => {
    setAll.current = options.cookies.setAll
    return { auth: { getUser } }
  },
}))

import { NextRequest, type NextResponse } from 'next/server'
import { getRedirectUrl } from 'next/experimental/testing/server'
import { AuthApiError, AuthRetryableFetchError, AuthSessionMissingError, type AuthError } from '@supabase/supabase-js'
import { proxy } from '@/proxy'

const AUTH_UNCHECKED = "Couldn't check your sign-in, so that didn't go through. Please try again."

const request = (path: string, method = 'GET', headers: Record<string, string> = {}) =>
  new NextRequest(`http://localhost${path}`, { method, headers })
const answers = (user: { id: string } | null, error: AuthError | null) =>
  getUser.mockResolvedValue({ data: { user }, error })

// What the proxy did with a request: let it through, sent it somewhere, or answered it itself.
async function outcome(res: NextResponse) {
  if (res.headers.get('x-middleware-next') === '1') return 'through'
  const to = getRedirectUrl(res)
  if (to) return `redirect ${new URL(to).pathname}`
  const type = res.headers.get('content-type')
  return { status: res.status, type, body: type?.includes('json') ? await res.json() : await res.text() }
}

// The page a page request gets when Supabase Auth cannot be asked: a 503 in HTML, never cached, in
// the words app/error.tsx uses, whose Try again reloads the page.
async function expectUncheckedPage(res: NextResponse) {
  expect(res.status).toBe(503)
  expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
  expect(res.headers.get('cache-control')).toBe('no-store')
  const html = await res.text()
  expect(html).toContain("<h1>Couldn't check your sign-in</h1>")
  expect(html).toContain('<p>Something went wrong reaching the sign-in service. Try again, or come back in a moment.</p>')
  expect(html).toContain('<a href="">Try again</a>')
  expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">')
  return html
}

const PAGES = ['/dashboard', '/settings', '/transactions?account=acct-1']
// Saves, and the bank link whose Item already exists at Plaid when it is called.
const APIS = ['/api/budgets', '/api/transactions/categorize', '/api/plaid/exchange-public-token']
const PUBLIC = ['/login', '/auth/confirm?code=abc', '/auth/try-again', '/plaid/oauth', '/api/plaid/webhook?secret=s']

let logs: unknown[][]
beforeEach(() => {
  getUser.mockReset()
  logs = []
  vi.spyOn(console, 'error').mockImplementation((...a) => void logs.push(a))
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('proxy: Supabase Auth could not be asked (#143)', () => {
  beforeEach(() => {
    answers(null, new AuthRetryableFetchError('fetch failed', 0))
  })

  // Let through, the page would render with no sign-in check: the layout's check does not stop the
  // page under it from running, and a session that can't be refreshed reads as no one, which gets
  // empty lists back (#143 review: "No banks connected yet." beside Connect a bank).
  it.each(PAGES)('answers %s with a 503 page that says sign-in could not be checked, rather than rendering it or sending it to /login', async (path) => {
    await expectUncheckedPage(await proxy(request(path)))
  })

  // Next's router fetches a page's payload with an RSC header; given any other reply, it loads the
  // page in full, which gets the same page.
  it('answers a client-side navigation the same way', async () => {
    await expectUncheckedPage(await proxy(request('/goals?_rsc=abc12', 'GET', { RSC: '1' })))
  })

  it('writes nothing from the address into the page', async () => {
    const html = await expectUncheckedPage(await proxy(request('/settings?x=%3Cscript%3Ealert(1)%3C/script%3E')))
    expect(html).toBe(await (await proxy(request('/settings'))).text())
    expect(html).not.toContain('<script')
  })

  it.each(APIS)('answers %s with a 503 in JSON, in words its control shows as they stand', async (path) => {
    expect(await outcome(await proxy(request(path, 'POST')))).toEqual({
      status: 503,
      type: 'application/json',
      body: { error: AUTH_UNCHECKED },
    })
  })

  it.each(PUBLIC)('lets %s through', async (path) => {
    expect(await outcome(await proxy(request(path)))).toBe('through')
  })

  it('logs it, so an outage can be told from sign-outs afterwards', async () => {
    await proxy(request('/dashboard'))
    expect(logs).toEqual([['[proxy] auth check failed', { status: 0, message: 'fetch failed' }]])
  })

  it('treats a 5xx from Supabase Auth the same way', async () => {
    answers(null, new AuthRetryableFetchError('HTTP 503', 503))
    await expectUncheckedPage(await proxy(request('/dashboard')))
    expect((await proxy(request('/api/budgets', 'POST'))).status).toBe(503)
  })

  // Supabase rotated the refresh token before the user read failed. Kept, the old one is refused
  // as already used on the next refresh, which ends the session the 503 was meant to spare.
  it('keeps a cookie the check refreshed before it failed, on the /api 503 and on the page', async () => {
    getUser.mockImplementation(async () => {
      setAll.current([{ name: 'sb-test-auth-token', value: 'rotated', options: { path: '/', maxAge: 34560000, sameSite: 'lax' } }])
      return { data: { user: null }, error: new AuthRetryableFetchError('fetch failed', 0) }
    })
    const rotated = { value: 'rotated', path: '/', maxAge: 34560000, sameSite: 'lax' }
    const api = await proxy(request('/api/budgets', 'POST'))
    expect(api.status).toBe(503)
    expect(api.cookies.get('sb-test-auth-token')).toMatchObject(rotated)
    const page = await proxy(request('/dashboard'))
    await expectUncheckedPage(page)
    expect(page.cookies.get('sb-test-auth-token')).toMatchObject(rotated)
  })
})

describe('proxy: the session has ended', () => {
  const ENDED = [
    ['no session', new AuthSessionMissingError()],
    ['a dead refresh token', new AuthApiError('Invalid Refresh Token: Refresh Token Not Found', 400, 'refresh_token_not_found')],
    ['a token Supabase Auth refused', new AuthApiError('invalid JWT', 403, 'bad_jwt')],
  ] as const

  it.each(ENDED)('sends a page to /login: %s', async (_, error) => {
    answers(null, error)
    for (const path of PAGES) expect(await outcome(await proxy(request(path)))).toBe('redirect /login')
  })

  // A client reads a redirect as "Your session ended. Sign in again." (lib/save-response.ts).
  it.each(ENDED)('sends an /api request to /login, as before: %s', async (_, error) => {
    answers(null, error)
    for (const path of APIS) expect(await outcome(await proxy(request(path, 'POST')))).toBe('redirect /login')
  })

  it.each(PUBLIC)('lets %s through', async (path) => {
    answers(null, new AuthSessionMissingError())
    expect(await outcome(await proxy(request(path)))).toBe('through')
  })

  it('logs nothing: a sign-out is nothing unusual', async () => {
    answers(null, new AuthSessionMissingError())
    await proxy(request('/dashboard'))
    expect(logs).toEqual([])
  })
})

describe('proxy: signed in', () => {
  beforeEach(() => {
    answers({ id: 'user-1' }, null)
  })

  it.each([...PAGES, ...PUBLIC])('lets %s through', async (path) => {
    expect(await outcome(await proxy(request(path)))).toBe('through')
  })

  it.each(APIS)('lets %s through', async (path) => {
    expect(await outcome(await proxy(request(path, 'POST')))).toBe('through')
  })

  it('checks once per request, and logs nothing', async () => {
    await proxy(request('/dashboard'))
    expect(getUser).toHaveBeenCalledTimes(1)
    expect(getUser).toHaveBeenCalledWith()
    expect(logs).toEqual([])
  })
})
