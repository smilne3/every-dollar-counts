import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ReactElement } from 'react'

// app/(app)/layout.tsx: every page's own sign-in check. #143: it redirected to /login whenever it
// found no user, including when Supabase Auth could not be asked, so an outage signed the person
// out even once the proxy let the page through.
//
// The stand-in is strict: getUser answers as supabase-js does, a user and no error or no user and
// the error, in auth-js's own error classes, and the one read the layout makes, the household's
// display name, resolves only as .from('households').select('id, name').limit(1). Anything else is
// a read this layout does not make, and throws.
const { client } = vi.hoisted(() => ({ client: { current: null as unknown } }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => client.current }))

import { AuthApiError, AuthRetryableFetchError, AuthSessionMissingError, type AuthError } from '@supabase/supabase-js'
import { getURLFromRedirectError } from 'next/dist/client/components/redirect'
import { isRedirectError } from 'next/dist/client/components/redirect-error'
import { AppShell } from '@/components/AppShell'
import AppLayout from '@/app/(app)/layout'

// Where a thrown redirect() was sending the person, or null for any other throw.
const redirectedTo = (e: unknown) => (isRedirectError(e) ? getURLFromRedirectError(e) : null)

function makeSupabase(user: { id: string; email?: string } | null, error: AuthError | null) {
  const reads: string[] = []
  client.current = {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user }, error }) },
    from: (table: string) => {
      if (table !== 'households') throw new Error(`the layout read ${table}`)
      return {
        select: (cols: string) => {
          reads.push(`${table}: ${cols}`)
          return { limit: (n: number) => Promise.resolve(n === 1 ? { data: [{ id: 'hh-1', name: 'The Milnes' }], error: null } : null) }
        },
      }
    },
  }
  return reads
}

const render = () => AppLayout({ children: <p>page</p> })
// What the layout threw, for a test that expects it to throw.
async function thrown() {
  try {
    await render()
  } catch (e) {
    return e
  }
  throw new Error('the layout did not throw')
}

let logs: unknown[][]
beforeEach(() => {
  logs = []
  vi.spyOn(console, 'error').mockImplementation((...a) => void logs.push(a))
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('app/(app)/layout.tsx: Supabase Auth could not be asked (#143)', () => {
  it.each([
    ['no connection', new AuthRetryableFetchError('fetch failed', 0)],
    ['a 5xx from Supabase Auth', new AuthRetryableFetchError('HTTP 503', 503)],
  ])('throws to app/error.tsx rather than redirecting to /login: %s', async (_, error) => {
    const reads = makeSupabase(null, error)
    const e = await thrown()
    expect(redirectedTo(e)).toBeNull()
    // Named, so the line Next logs with the boundary's digest says what failed (#130).
    expect(e).toBeInstanceOf(Error)
    expect((e as Error).message).toBe(`could not check sign-in: ${error.message}`)
    expect(reads).toEqual([])
  })

  it('logs it', async () => {
    makeSupabase(null, new AuthRetryableFetchError('fetch failed', 0))
    await thrown()
    expect(logs).toEqual([['[layout] auth check failed', { status: 0, message: 'fetch failed' }]])
  })
})

describe('app/(app)/layout.tsx: the session has ended', () => {
  it.each([
    ['no session', new AuthSessionMissingError()],
    ['a dead refresh token', new AuthApiError('Invalid Refresh Token: Refresh Token Not Found', 400, 'refresh_token_not_found')],
    ['a token Supabase Auth refused', new AuthApiError('invalid JWT', 403, 'bad_jwt')],
  ])('redirects to /login and reads nothing: %s', async (_, error) => {
    const reads = makeSupabase(null, error)
    expect(redirectedTo(await thrown())).toBe('/login')
    expect(reads).toEqual([])
    expect(logs).toEqual([])
  })
})

describe('app/(app)/layout.tsx: signed in', () => {
  it("renders the app's shell, with the household's name and the person's email", async () => {
    const reads = makeSupabase({ id: 'user-1', email: 'sarah@example.com' }, null)
    const shell = (await render()) as ReactElement<{ householdName: string; userEmail: string; children: ReactElement }>
    expect(shell.type).toBe(AppShell)
    expect(shell.props.householdName).toBe('The Milnes')
    expect(shell.props.userEmail).toBe('sarah@example.com')
    expect(reads).toEqual(['households: id, name'])
    expect(logs).toEqual([])
  })
})
