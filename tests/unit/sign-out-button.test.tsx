import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { AuthRetryableFetchError } from '@supabase/supabase-js'

// Sign out (#143 review). It ignored signOut()'s error. With an expired token in a Supabase Auth
// outage, supabase-js removes nothing, at any scope, so the session's cookie outlived "Sign out",
// which matters on a shared device.
const { router, client } = vi.hoisted(() => ({
  router: { push: vi.fn(), refresh: vi.fn() },
  // The client a test hands the button; null for the real one.
  client: { current: null as unknown },
}))
vi.mock('next/navigation', () => ({ useRouter: () => router }))
vi.mock('@/lib/supabase/client', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/supabase/client')>()
  return { ...real, createClient: () => client.current ?? real.createClient() }
})

import { SignOutButton } from '@/components/SignOutButton'

const cookieNames = () =>
  document.cookie
    .split(';')
    .map((c) => c.trim().split('=')[0])
    .filter(Boolean)
    .sort()

let logs: unknown[][]
beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://test.supabase.co')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'test-publishable-key')
  logs = []
  vi.spyOn(console, 'error').mockImplementation((...a) => void logs.push(a))
})
afterEach(() => {
  cleanup()
  for (const name of cookieNames()) document.cookie = `${name}=; Max-Age=0; path=/`
  client.current = null
  router.push.mockClear()
  router.refresh.mockClear()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('SignOutButton', () => {
  it('clears the session cookie itself when sign-out fails, so this device is signed out anyway, and logs why', async () => {
    // A session long enough for @supabase/ssr to split, beside a cookie that is not the session's.
    document.cookie = 'sb-test-auth-token.0=base64-first-half; path=/'
    document.cookie = 'sb-test-auth-token.1=second-half; path=/'
    document.cookie = 'theme=light; path=/'
    // What supabase-js answers when it could not refresh the session first: an error, and nothing
    // removed.
    const signOut = vi.fn().mockResolvedValue({ error: new AuthRetryableFetchError('fetch failed', 0) })
    client.current = { auth: { signOut } }
    render(<SignOutButton />)

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))

    await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith('/login'))
    expect(cookieNames()).toEqual(['theme'])
    expect(logs).toEqual([['[SignOutButton] sign-out failed', { status: 0, message: 'fetch failed' }]])
  })

  it('signs out everywhere, through Supabase Auth, and then goes to /login', async () => {
    const signOut = vi.fn().mockResolvedValue({ error: null })
    client.current = { auth: { signOut } }
    render(<SignOutButton />)

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))

    await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith('/login'))
    // No scope: supabase-js's default, global.
    expect(signOut).toHaveBeenCalledWith()
    expect(router.refresh).toHaveBeenCalled()
    expect(logs).toEqual([])
  })

  // The real browser client, with an expired session and a Supabase Auth it cannot reach. Fake
  // timers stand in for the 25 seconds of retries auth-js spends trying to refresh it first.
  it('with the real client: an expired session Supabase Auth cannot refresh is still signed out', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] })
    const session = {
      access_token: 'expired-access',
      refresh_token: 'refresh-1',
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) - 600,
      user: { id: 'user-1' },
    }
    document.cookie = `sb-test-auth-token=base64-${Buffer.from(JSON.stringify(session)).toString('base64url')}; path=/`
    const fetch = vi.fn<(input: RequestInfo | URL) => Promise<Response>>(async () => {
      throw new TypeError('fetch failed')
    })
    vi.stubGlobal('fetch', fetch)
    render(<SignOutButton />)

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    await vi.runAllTimersAsync()

    await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith('/login'))
    expect(cookieNames()).toEqual([])
    // It did try to refresh, and found Supabase Auth unreachable.
    expect(fetch.mock.calls.some(([url]) => String(url).startsWith('https://test.supabase.co/auth/v1/token'))).toBe(true)
  })
})
