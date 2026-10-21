// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createServerClient } from '@supabase/ssr'
import {
  AuthApiError,
  AuthRetryableFetchError,
  AuthSessionMissingError,
  AuthUnknownError,
  type AuthError,
  type User,
} from '@supabase/supabase-js'
import { checkSignIn } from '@/lib/auth-check'

// lib/auth-check.ts holds the rule every sign-in check follows (#143): only a check Supabase Auth
// could not answer is "unknown"; every other failure is a session that has ended.

const USER = { id: 'user-1', email: 'sarah@example.com' } as User

// getUser as supabase-js answers it: a user and no error, or no user and the error.
const answering = (user: User | null, error: AuthError | null) => ({
  auth: { getUser: vi.fn().mockResolvedValue({ data: { user }, error }) },
})

let logs: unknown[][]
beforeEach(() => {
  logs = []
  vi.spyOn(console, 'error').mockImplementation((...a) => void logs.push(a))
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('checkSignIn', () => {
  it.each([
    ['no connection', new AuthRetryableFetchError('fetch failed', 0)],
    ['a 5xx from Supabase Auth', new AuthRetryableFetchError('HTTP 503', 503)],
  ])("reads %s as unknown, and logs it under the caller's tag", async (_, error) => {
    expect(await checkSignIn(answering(null, error), '[here]')).toEqual({ state: 'unknown', error })
    expect(logs).toEqual([['[here] auth check failed', { status: error.status, message: error.message }]])
  })

  // A dead refresh token on an expired session comes back as the refresh call's own 4xx, not as a
  // missing session. It has ended all the same: "try again" would never succeed.
  it.each([
    ['no session', new AuthSessionMissingError()],
    ['refresh_token_not_found', new AuthApiError('Invalid Refresh Token: Refresh Token Not Found', 400, 'refresh_token_not_found')],
    ['refresh_token_already_used', new AuthApiError('Invalid Refresh Token: Already Used', 400, 'refresh_token_already_used')],
    ['session_expired', new AuthApiError('Session Expired', 403, 'session_expired')],
    ['a token Supabase Auth refused', new AuthApiError('invalid JWT', 403, 'bad_jwt')],
    ['an answer that could not be read', new AuthUnknownError('Unexpected token < in JSON', null)],
  ])('reads %s as ended, and logs nothing', async (_, error) => {
    expect(await checkSignIn(answering(null, error), '[here]')).toEqual({ state: 'ended' })
    expect(logs).toEqual([])
  })

  it('reads a user as signed in, and logs nothing', async () => {
    expect(await checkSignIn(answering(USER, null), '[here]')).toEqual({ state: 'signed-in', user: USER })
    expect(logs).toEqual([])
  })

  it('asks Supabase Auth once, for the session it was given', async () => {
    const supabase = answering(USER, null)
    await checkSignIn(supabase, '[here]')
    expect(supabase.auth.getUser).toHaveBeenCalledTimes(1)
    expect(supabase.auth.getUser).toHaveBeenCalledWith()
  })
})

// The stand-ins above use auth-js's own error classes. These run the real client the proxy and the
// server components use, so an auth-js upgrade that reported a dropped connection some other way,
// and signed everyone out again on the next outage, fails here rather than in production.
describe('checkSignIn with a real Supabase client', () => {
  const URL = 'https://test.supabase.co'
  const session = {
    access_token: 'access-token',
    refresh_token: 'refresh-token',
    token_type: 'bearer',
    expires_in: 3600,
    // An hour off, so the check goes straight to the user and refreshes nothing.
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: 'user-1' },
  }
  // The cookie @supabase/ssr writes: the session as base64url JSON, under the project's storage key.
  const SESSION_COOKIE = { name: 'sb-test-auth-token', value: `base64-${Buffer.from(JSON.stringify(session)).toString('base64url')}` }
  const client = (fetch: typeof globalThis.fetch, cookies = [SESSION_COOKIE]) =>
    createServerClient(URL, 'test-publishable-key', {
      cookies: { getAll: () => cookies, setAll: () => {} },
      global: { fetch },
    })
  const asked = (fetch: ReturnType<typeof vi.fn>) => fetch.mock.calls.map(([url]) => String(url))

  it('reads a connection that fails as unknown', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError('fetch failed')
    })
    expect(await checkSignIn(client(fetch), '[here]')).toMatchObject({ state: 'unknown' })
    expect(asked(fetch)).toEqual([`${URL}/auth/v1/user`])
  })

  it('reads a 503 from Supabase Auth as unknown', async () => {
    const fetch = vi.fn(async () => new Response('upstream connect error', { status: 503 }))
    expect(await checkSignIn(client(fetch), '[here]')).toMatchObject({ state: 'unknown' })
    expect(asked(fetch)).toEqual([`${URL}/auth/v1/user`])
  })

  it('reads a token Supabase Auth refused as ended', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: 'bad_jwt', message: 'invalid JWT: unable to parse or verify signature' }), {
          status: 403,
          headers: { 'content-type': 'application/json', 'x-supabase-api-version': '2024-01-01' },
        })
    )
    expect(await checkSignIn(client(fetch), '[here]')).toEqual({ state: 'ended' })
    expect(logs).toEqual([])
  })

  it('reads the user Supabase Auth returns as signed in', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ id: 'user-1', email: 'sarah@example.com' }), { status: 200 }))
    expect(await checkSignIn(client(fetch), '[here]')).toMatchObject({ state: 'signed-in', user: { id: 'user-1', email: 'sarah@example.com' } })
  })

  it('reads no session cookie as ended, without asking Supabase Auth', async () => {
    const fetch = vi.fn(async () => new Response('{}', { status: 200 }))
    expect(await checkSignIn(client(fetch, []), '[here]')).toEqual({ state: 'ended' })
    expect(fetch).not.toHaveBeenCalled()
  })
})
