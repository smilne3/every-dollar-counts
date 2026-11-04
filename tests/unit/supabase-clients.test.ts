// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The two server-side clients' reads go through the read limit (#202), checked through the real
// @supabase/ssr and supabase-js, not by what they were constructed with: a version of either that stopped
// passing global.fetch on would fail here. Nothing leaves the machine. The limit's fetch is replaced by one
// that answers every request itself, and so is the global fetch, which only a bypass would reach. What the
// limit does is in tests/unit/read-deadline.test.ts. proxy.ts builds a third client, which only asks
// Supabase Auth, so it has nothing the limit applies to.
const { limited, unlimited } = vi.hoisted(() => {
  type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  const answer = async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
  return { limited: vi.fn<Fetch>(answer), unlimited: vi.fn<Fetch>(answer) }
})
vi.mock('@/lib/supabase/read-deadline', () => ({ fetchWithReadDeadline: limited }))
vi.mock('next/headers', () => ({ cookies: async () => ({ getAll: () => [], set: () => {} }) }))

beforeEach(() => {
  vi.resetModules()
  limited.mockClear()
  unlimited.mockClear()
  vi.stubGlobal('fetch', unlimited)
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:9')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'made-up-publishable-key')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'made-up-service-role-key')
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

const sentThroughTheLimit = () => limited.mock.calls.map(([input]) => String(input))

describe('the server-side Supabase clients send their reads through the limit (#202)', () => {
  it("the pages' client", async () => {
    const { createClient } = await import('@/lib/supabase/server')
    const { error } = await (await createClient()).from('accounts').select('id')
    expect(error).toBeNull()
    expect(sentThroughTheLimit()).toEqual(['http://127.0.0.1:9/rest/v1/accounts?select=id'])
    expect(unlimited).not.toHaveBeenCalled()
  })

  it('the service-role client', async () => {
    const { supabaseAdmin } = await import('@/lib/supabase/admin')
    const { error } = await supabaseAdmin.from('accounts').select('id')
    expect(error).toBeNull()
    expect(sentThroughTheLimit()).toEqual(['http://127.0.0.1:9/rest/v1/accounts?select=id'])
    expect(unlimited).not.toHaveBeenCalled()
  })
})
