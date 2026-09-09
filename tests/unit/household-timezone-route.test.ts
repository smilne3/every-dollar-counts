import { describe, it, expect, beforeEach, vi } from 'vitest'

// vi.hoisted for the same reason as tests/unit/manual-assets-env.test.ts: the static route import
// below is linked before this file's body runs.
const { state } = vi.hoisted(() => ({
  state: {
    user: { id: 'u-1' } as { id: string } | null,
    membership: { data: { household_id: 'hh-1' }, error: null } as {
      data: { household_id: string } | null
      error: { message: string } | null
    },
    updateResult: { error: null, count: 1 } as { error: { message: string } | null; count: number },
    updated: [] as unknown[],
  },
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: state.user } }) },
    from: (table: string) =>
      table === 'memberships'
        ? { select: () => ({ limit: () => ({ single: async () => state.membership }) }) }
        : {
            update: (patch: unknown) => {
              state.updated.push(patch)
              return { eq: async () => state.updateResult }
            },
          },
  }),
}))

import { POST } from '@/app/api/household/timezone/route'

const post = (body: unknown) =>
  POST(
    new Request('http://localhost/api/household/timezone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  )

beforeEach(() => {
  state.user = { id: 'u-1' }
  state.membership = { data: { household_id: 'hh-1' }, error: null }
  state.updateResult = { error: null, count: 1 }
  state.updated = []
})

describe('POST /api/household/timezone', () => {
  it('rejects an unauthenticated caller', async () => {
    state.user = null
    const res = await post({ timezone: 'America/Chicago' })
    expect(res.status).toBe(401)
    expect(state.updated).toEqual([])
  })

  // Validated before the database is touched: Postgres cannot check an IANA name, so this is the
  // only place it can be checked at all.
  it('rejects a zone Intl does not know, without writing', async () => {
    const res = await post({ timezone: 'Mars/Olympus_Mons' })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'That is not a timezone we recognise.' })
    expect(state.updated).toEqual([])
  })

  it('rejects a missing timezone', async () => {
    const res = await post({})
    expect(res.status).toBe(400)
    expect(state.updated).toEqual([])
  })

  it('writes a valid zone', async () => {
    const res = await post({ timezone: 'America/Chicago' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(state.updated).toEqual([{ timezone: 'America/Chicago' }])
  })

  // households had no update policy before #73's migration. If it is ever missing again, the
  // update matches zero rows and Supabase reports SUCCESS — so a silent no-op has to be caught
  // here rather than shown to the user as a save that worked.
  it('reports a write that changed nothing rather than claiming success', async () => {
    state.updateResult = { error: null, count: 0 }
    const res = await post({ timezone: 'America/Chicago' })
    expect(res.status).toBe(500)
    expect((await res.json()).error).toMatch(/could not be saved/i)
  })

  it('reports a failed write without leaking the database\'s words', async () => {
    state.updateResult = { error: { message: 'permission denied for table households' }, count: 0 }
    const res = await post({ timezone: 'America/Chicago' })
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('permission denied')
  })
})
