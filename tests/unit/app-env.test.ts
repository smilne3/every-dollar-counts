import { describe, it, expect, vi, beforeEach } from 'vitest'

// lib/app-env.ts imports supabaseAdmin, whose module scope calls createClient(...). Vitest does
// not load .env.local, so without this the import throws "supabaseUrl is required" before any
// test body runs. Same reason as tests/unit/ingest-reimbursable.test.ts.
const maybeSingle = vi.fn()
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: { from: () => ({ select: () => ({ maybeSingle }) }) },
}))

// plaidEnv is a module constant frozen at import time, so the app side of the comparison has to
// be mocked to test a mismatch. vitest.config.mts pins the real one to 'sandbox'.
vi.mock('@/lib/plaid', () => ({ plaidEnv: 'sandbox' }))

async function freshModule() {
  vi.resetModules()
  return import('@/lib/app-env')
}

describe('assertEnvMatchesDatabase', () => {
  beforeEach(() => {
    maybeSingle.mockReset()
  })

  it('resolves when the database environment matches the app', async () => {
    maybeSingle.mockResolvedValue({ data: { plaid_env: 'sandbox' }, error: null })
    const { assertEnvMatchesDatabase } = await freshModule()
    await expect(assertEnvMatchesDatabase()).resolves.toBeUndefined()
  })

  it('throws EnvMismatchError when the database belongs to another environment', async () => {
    maybeSingle.mockResolvedValue({ data: { plaid_env: 'production' }, error: null })
    const { assertEnvMatchesDatabase, EnvMismatchError } = await freshModule()
    await expect(assertEnvMatchesDatabase()).rejects.toBeInstanceOf(EnvMismatchError)
  })

  it('names both environments in the mismatch error', async () => {
    maybeSingle.mockResolvedValue({ data: { plaid_env: 'production' }, error: null })
    const { assertEnvMatchesDatabase } = await freshModule()
    await expect(assertEnvMatchesDatabase()).rejects.toThrow(/sandbox.*production|production.*sandbox/)
  })

  // Fails CLOSED. A missing row must never be read as "no constraint configured, carry on" --
  // that would silently restore the exact hole this table exists to close.
  it('throws when the app_env row is missing', async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null })
    const { assertEnvMatchesDatabase } = await freshModule()
    await expect(assertEnvMatchesDatabase()).rejects.toThrow(/app_env/)
  })

  it('throws when app_env cannot be read', async () => {
    maybeSingle.mockResolvedValue({ data: null, error: { message: 'connection reset' } })
    const { assertEnvMatchesDatabase } = await freshModule()
    await expect(assertEnvMatchesDatabase()).rejects.toThrow(/connection reset/)
  })

  it('reads the database only once across repeated calls', async () => {
    maybeSingle.mockResolvedValue({ data: { plaid_env: 'sandbox' }, error: null })
    const { assertEnvMatchesDatabase } = await freshModule()
    await assertEnvMatchesDatabase()
    await assertEnvMatchesDatabase()
    await assertEnvMatchesDatabase()
    expect(maybeSingle).toHaveBeenCalledTimes(1)
  })

  // A cold start can serve several guarded requests at once. Without in-flight deduplication each
  // one issues its own app_env query before the first has a value to cache.
  it('shares one read across calls that start before it resolves', async () => {
    let release: (v: unknown) => void = () => {}
    maybeSingle.mockReturnValue(
      new Promise((r) => {
        release = r
      })
    )
    const { assertEnvMatchesDatabase } = await freshModule()
    const first = assertEnvMatchesDatabase()
    const second = assertEnvMatchesDatabase()
    release({ data: { plaid_env: 'sandbox' }, error: null })
    await Promise.all([first, second])
    expect(maybeSingle).toHaveBeenCalledTimes(1)
  })

  // A cached failure would turn one transient blip into a permanent outage for that process,
  // because the guard fails closed. Cache the success, retry the failure.
  it('does not cache a failed read', async () => {
    maybeSingle.mockResolvedValueOnce({ data: null, error: { message: 'timeout' } })
    maybeSingle.mockResolvedValueOnce({ data: { plaid_env: 'sandbox' }, error: null })
    const { assertEnvMatchesDatabase } = await freshModule()
    await expect(assertEnvMatchesDatabase()).rejects.toThrow(/timeout/)
    await expect(assertEnvMatchesDatabase()).resolves.toBeUndefined()
    expect(maybeSingle).toHaveBeenCalledTimes(2)
  })

  // The two above cover concurrent SUCCESS and sequential FAILURE. This is where they meet, and
  // it is the case the deduplication comment actually promises: a cold start whose very first
  // app_env read fails while several requests are already waiting on it. All of them must see the
  // failure, and the rejected in-flight promise must be cleared rather than left for the next
  // caller to inherit — otherwise one blip fails every later request for the life of the process.
  it('shares one failing read, and still retries afterwards', async () => {
    let reject: (e: unknown) => void = () => {}
    maybeSingle.mockReturnValueOnce(
      new Promise((_, r) => {
        reject = r
      })
    )
    maybeSingle.mockResolvedValueOnce({ data: { plaid_env: 'sandbox' }, error: null })
    const { assertEnvMatchesDatabase } = await freshModule()

    // allSettled attaches both handlers before the rejection lands, so neither is ever unhandled.
    const settled = Promise.allSettled([assertEnvMatchesDatabase(), assertEnvMatchesDatabase()])
    reject(new Error('connection reset'))
    const outcomes = (await settled).map((r) =>
      r.status === 'rejected' ? String(r.reason) : 'RESOLVED'
    )

    expect(outcomes).toEqual([
      expect.stringContaining('connection reset'),
      expect.stringContaining('connection reset'),
    ])
    expect(maybeSingle).toHaveBeenCalledTimes(1)

    // Nothing cached, nothing left in flight: the next call issues a second read and succeeds.
    await expect(assertEnvMatchesDatabase()).resolves.toBeUndefined()
    expect(maybeSingle).toHaveBeenCalledTimes(2)
  })
})
