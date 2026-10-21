import { describe, it, expect, vi, beforeEach } from 'vitest'

// #28 spec §14.5 "When it runs": the sync route asks Jev for suggestions through after(), once the
// response is sent. A failure there must never reach the response, its status, or any bank's health.
//
// vi.hoisted for the same reason as tests/unit/remove-item-env.test.ts: the static route import below
// is linked before this file's body runs, firing every mock factory.
const { afterFns, suggestCategories, storeAccounts, syncAndStore, items, updates } = vi.hoisted(() => ({
  afterFns: [] as (() => unknown)[],
  suggestCategories: vi.fn(),
  storeAccounts: vi.fn(),
  syncAndStore: vi.fn(),
  items: { rows: [] as Record<string, unknown>[] },
  updates: [] as { values: unknown; id: unknown }[],
}))

vi.mock('next/server', async (orig) => ({
  ...(await orig<typeof import('next/server')>()),
  after: (fn: () => unknown) => {
    afterFns.push(fn)
  },
}))
vi.mock('@/lib/category-suggest', () => ({ suggestCategories }))
vi.mock('@/lib/ingest', () => ({ storeAccounts, syncAndStore }))
vi.mock('@/lib/crypto', () => ({ decrypt: () => 'access-token' }))
vi.mock('@/lib/plaid', () => ({ plaidEnv: 'sandbox' }))
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({ eq: () => ({ eq: async () => ({ data: items.rows }) }) }),
      // A recovered bank's reset goes on to .neq(), which leaves a broken login alone.
      update: (values: unknown) => ({
        eq: (_col: string, id: unknown) => {
          updates.push({ values, id })
          const reply = Promise.resolve({ error: null })
          return Object.assign(reply, { neq: () => reply })
        },
      }),
    }),
  },
}))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } } }) },
    from: () => ({
      select: () => ({
        limit: () => ({ maybeSingle: async () => ({ data: { household_id: 'hh-1' } }) }),
      }),
    }),
  }),
}))

import { POST } from '@/app/api/plaid/sync-transactions/route'

const item = (over: Record<string, unknown> = {}) => ({
  id: 'item-1',
  household_id: 'hh-1',
  access_token_encrypted: 'cipher',
  cursor: null,
  products: ['transactions'],
  status: 'ok',
  institution_name: 'Chase',
  ...over,
})

// The response, its status, and the plaid_items writes, with every scheduled after() run to the end.
async function syncAndRunAfter() {
  const res = await POST()
  const body = await res.json()
  for (const fn of afterFns) await expect(Promise.resolve().then(fn)).resolves.not.toThrow()
  return { status: res.status, body, updates: [...updates] }
}

beforeEach(() => {
  afterFns.length = 0
  updates.length = 0
  suggestCategories.mockReset()
  storeAccounts.mockReset().mockResolvedValue(undefined)
  syncAndStore.mockReset().mockResolvedValue({ added: 2, modified: 1, removed: 0 })
  items.rows = [item()]
})

describe('POST /api/plaid/sync-transactions suggestions (#28 §14.5)', () => {
  it('schedules exactly one suggestion run for the household, after the response', async () => {
    suggestCategories.mockResolvedValue({ suggested: 0 })
    const res = await POST()
    expect(res.status).toBe(200)
    expect(afterFns).toHaveLength(1)
    // Scheduled, not run: the response does not wait on Jev.
    expect(suggestCategories).not.toHaveBeenCalled()
    await afterFns[0]()
    expect(suggestCategories).toHaveBeenCalledExactlyOnceWith('hh-1', { startedAt: expect.any(Number) })
  })

  // after() shares the route's max duration, which starts with the request, so the job's deadline
  // counts from the start of the handler, not from when after() runs.
  // The clock moves a minute between the response and after(), so a time read when after() runs fails.
  it('passes the time the request started as startedAt', async () => {
    suggestCategories.mockResolvedValue({ suggested: 0 })
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2026-10-15T12:00:00.000Z'))
      const requested = Date.now()
      await POST()
      vi.setSystemTime(requested + 60_000)
      await afterFns[0]()
      expect(suggestCategories).toHaveBeenCalledExactlyOnceWith('hh-1', { startedAt: requested })
    } finally {
      vi.useRealTimers()
    }
  })

  // Its contract says it never throws; the route does not rely on that. A recovering bank makes the
  // route write plaid_items, so the comparison also covers the bank's health flag.
  it('leaves the response, its status and every bank write unchanged when suggesting rejects', async () => {
    items.rows = [item({ status: 'temporarily_unavailable' })]
    suggestCategories.mockResolvedValue({ suggested: 3 })
    const resolved = await syncAndRunAfter()

    afterFns.length = 0
    updates.length = 0
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    suggestCategories.mockRejectedValue(new Error('jev down'))
    const rejected = await syncAndRunAfter()

    expect(rejected).toEqual(resolved)
    expect(rejected.updates).toEqual([{ values: { status: 'ok', status_detail: null }, id: 'item-1' }])
    expect(log).toHaveBeenCalledWith('[suggest] failed', 'hh-1', 'jev down')
    log.mockRestore()
  })

  // Harmless: the job only suggests for rows already stored.
  it('still schedules the run when every bank fails to sync', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    storeAccounts.mockRejectedValue(new Error('boom'))
    const res = await POST()
    const body = await res.json()
    expect(body.failed).toBe(1)
    expect(afterFns).toHaveLength(1)
    log.mockRestore()
  })
})
