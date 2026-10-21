// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// GET /auth/confirm: where Google and the email links land, to finish signing in and then run the
// invite check (lib/access.ts).
//
// #143: if the check right after sign-in failed, the person was sent to "Not invited yet", even when
// Supabase Auth simply could not be asked.
//
// The stand-in is strict: a client with the four auth calls this route makes and nothing else, each
// answering as supabase-js does, with auth-js's own error classes. The invite check is a stand-in
// too, so a test can say whether it ran.
const { auth, ensureHouseholdAccess } = vi.hoisted(() => ({
  auth: { exchangeCodeForSession: vi.fn(), verifyOtp: vi.fn(), getUser: vi.fn(), signOut: vi.fn() },
  ensureHouseholdAccess: vi.fn(),
}))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth }) }))
vi.mock('@/lib/access', () => ({ ensureHouseholdAccess }))

import { NextRequest } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { AuthApiError, AuthRetryableFetchError, AuthSessionMissingError, type AuthError } from '@supabase/supabase-js'
import { GET } from '@/app/auth/confirm/route'

const USER = { id: 'user-1', email: 'sarah@example.com' }
const SIGNED_IN = { data: { user: USER, session: { access_token: 'a' } }, error: null }

const confirm = (query: string) => GET(new NextRequest(`http://localhost/auth/confirm?${query}`))
// Where the route sent the person.
const sentTo = async (res: Promise<Response>) => {
  const r = await res
  expect(r.status).toBe(307)
  return new URL(r.headers.get('location')!).pathname
}
const userIs = (user: typeof USER | null, error: AuthError | null) => auth.getUser.mockResolvedValue({ data: { user }, error })

let logs: unknown[][]
beforeEach(() => {
  for (const f of Object.values(auth)) f.mockReset()
  ensureHouseholdAccess.mockReset().mockResolvedValue(true)
  auth.exchangeCodeForSession.mockResolvedValue(SIGNED_IN)
  auth.verifyOtp.mockResolvedValue(SIGNED_IN)
  // What a local sign-out answers when Supabase Auth can't be told, having removed the session here.
  auth.signOut.mockResolvedValue({ error: new AuthRetryableFetchError('fetch failed', 0) })
  userIs(USER, null)
  logs = []
  vi.spyOn(console, 'error').mockImplementation((...a) => void logs.push(a))
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('GET /auth/confirm: signed in', () => {
  it('sends an invited person on to where they were going, still signed in', async () => {
    expect(await sentTo(confirm('code=abc&next=/settings'))).toBe('/settings')
    expect(auth.exchangeCodeForSession).toHaveBeenCalledWith('abc')
    expect(ensureHouseholdAccess).toHaveBeenCalledWith('user-1', 'sarah@example.com')
    expect(auth.signOut).not.toHaveBeenCalled()
    expect(logs).toEqual([])
  })

  it('sends an invited person to the dashboard when nothing else was asked for', async () => {
    expect(await sentTo(confirm('code=abc'))).toBe('/dashboard')
  })

  it('finishes an email link the same way', async () => {
    expect(await sentTo(confirm('token_hash=th&type=magiclink'))).toBe('/dashboard')
    expect(auth.verifyOtp).toHaveBeenCalledWith({ type: 'magiclink', token_hash: 'th' })
  })

  it('sends someone the invite check turns away to "Not invited yet"', async () => {
    ensureHouseholdAccess.mockResolvedValue(false)
    expect(await sentTo(confirm('code=abc'))).toBe('/auth/not-invited')
  })
})

describe('GET /auth/confirm: Supabase Auth could not be asked after sign-in (#143)', () => {
  it.each([
    ['no connection', new AuthRetryableFetchError('fetch failed', 0)],
    ['a 5xx from Supabase Auth', new AuthRetryableFetchError('HTTP 503', 503)],
  ])('says sign-in could not be completed, never "Not invited yet", and runs no invite check: %s', async (_, error) => {
    userIs(null, error)
    expect(await sentTo(confirm('code=abc'))).toBe('/auth/try-again')
    expect(ensureHouseholdAccess).not.toHaveBeenCalled()
  })

  // The exchange set the new session's cookie. Kept, the person could open the app with the invite
  // check never run, and an invited first-timer would find no household (#143 review).
  it('signs the new session out here, before it redirects', async () => {
    userIs(null, new AuthRetryableFetchError('fetch failed', 0))
    let release!: () => void
    auth.signOut.mockReturnValue(new Promise((resolve) => (release = () => resolve({ error: new AuthRetryableFetchError('fetch failed', 0) }))))
    let answered = false
    const pending = confirm('code=abc').then((res) => ((answered = true), res))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(auth.signOut).toHaveBeenCalledWith({ scope: 'local' })
    expect(answered).toBe(false)
    release()
    expect(await sentTo(pending)).toBe('/auth/try-again')
    expect(auth.signOut).toHaveBeenCalledTimes(1)
  })

  it('logs it', async () => {
    userIs(null, new AuthRetryableFetchError('fetch failed', 0))
    await confirm('code=abc')
    expect(logs).toEqual([['[auth/confirm] auth check failed', { status: 0, message: 'fetch failed' }]])
  })
})

// What the route relies on above: a local sign-out removes a session this fresh even when Supabase
// Auth can't be told. The real client, with the cookie the exchange leaves and a connection that fails.
describe('a local sign-out with the real Supabase client, when Supabase Auth cannot be reached', () => {
  it('still clears the new session cookie', async () => {
    const session = {
      access_token: 'fresh-access',
      refresh_token: 'fresh-refresh',
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: { id: 'user-1' },
    }
    const cookie = { name: 'sb-test-auth-token', value: `base64-${Buffer.from(JSON.stringify(session)).toString('base64url')}` }
    const written: { name: string; value: string; options: { maxAge?: number } }[] = []
    const fetch = vi.fn(async () => {
      throw new TypeError('fetch failed')
    })
    const client = createServerClient('https://test.supabase.co', 'test-publishable-key', {
      cookies: { getAll: () => [cookie], setAll: (list) => void written.push(...list) },
      global: { fetch },
    })
    const { error } = await client.auth.signOut({ scope: 'local' })
    expect(error).toBeInstanceOf(AuthRetryableFetchError)
    expect(written).toContainEqual(expect.objectContaining({ name: 'sb-test-auth-token', value: '', options: expect.objectContaining({ maxAge: 0 }) }))
  })
})

describe('GET /auth/confirm: the session ended right after sign-in', () => {
  it.each([
    ['no session', new AuthSessionMissingError()],
    ['a token Supabase Auth refused', new AuthApiError('invalid JWT', 403, 'bad_jwt')],
  ])('sends the person to sign in again, not to "Not invited yet", runs no invite check, and logs why: %s', async (_, error) => {
    userIs(null, error)
    expect(await sentTo(confirm('code=abc'))).toBe('/login')
    expect(ensureHouseholdAccess).not.toHaveBeenCalled()
    expect(auth.signOut).not.toHaveBeenCalled()
    expect(logs).toEqual([
      ['[auth/confirm] session ended right after sign-in', { status: error.status, code: error.code, message: error.message }],
    ])
  })
})

// A code or token Supabase Auth never answered says nothing about the link: before, it read as
// "That link didn't work. The login link was invalid or expired."
describe('GET /auth/confirm: Supabase Auth could not be asked to finish signing in (#143)', () => {
  it('sends a code exchange that got no answer to try again, and checks no further', async () => {
    auth.exchangeCodeForSession.mockResolvedValue({ data: { user: null, session: null }, error: new AuthRetryableFetchError('fetch failed', 0) })
    expect(await sentTo(confirm('code=abc'))).toBe('/auth/try-again')
    expect(auth.getUser).not.toHaveBeenCalled()
    expect(ensureHouseholdAccess).not.toHaveBeenCalled()
    expect(logs).toEqual([['[auth/confirm] sign-in exchange failed', { status: 0, message: 'fetch failed' }]])
  })

  it('sends an email link Supabase Auth answered with a 5xx to try again', async () => {
    auth.verifyOtp.mockResolvedValue({ data: { user: null, session: null }, error: new AuthRetryableFetchError('HTTP 503', 503) })
    expect(await sentTo(confirm('token_hash=th&type=magiclink'))).toBe('/auth/try-again')
    expect(auth.getUser).not.toHaveBeenCalled()
  })
})

describe('GET /auth/confirm: the link itself', () => {
  it('sends a code Supabase Auth refused to "That link didn\'t work", and checks no further', async () => {
    auth.exchangeCodeForSession.mockResolvedValue({
      data: { user: null, session: null },
      error: new AuthApiError('invalid flow state, no valid flow state found', 404, 'flow_state_not_found'),
    })
    expect(await sentTo(confirm('code=abc'))).toBe('/auth/auth-code-error')
    expect(auth.getUser).not.toHaveBeenCalled()
    expect(ensureHouseholdAccess).not.toHaveBeenCalled()
  })

  it('sends an email link Supabase Auth refused to "That link didn\'t work"', async () => {
    auth.verifyOtp.mockResolvedValue({
      data: { user: null, session: null },
      error: new AuthApiError('Email link is invalid or has expired', 403, 'otp_expired'),
    })
    expect(await sentTo(confirm('token_hash=th&type=magiclink'))).toBe('/auth/auth-code-error')
    expect(auth.getUser).not.toHaveBeenCalled()
  })

  it('sends a request with neither a code nor a token to "That link didn\'t work"', async () => {
    expect(await sentTo(confirm('next=/settings'))).toBe('/auth/auth-code-error')
    expect(auth.exchangeCodeForSession).not.toHaveBeenCalled()
    expect(auth.verifyOtp).not.toHaveBeenCalled()
  })
})
