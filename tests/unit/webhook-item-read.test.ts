import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The webhook's read of the item it is about (#91). A failed read used to be handled as an unknown
// item and acknowledged with a 200 "so Plaid stops retrying", which dropped the webhook for good: no
// sync for new transactions, no needs_reconnect for a broken bank. Plaid redelivers a webhook that
// gets a non-2xx answer, and this read is cheap and safe to repeat.
//
// The stand-in is strict, as in tests/unit/categorize-route.test.ts (#99): the read resolves only
// through .from('plaid_items').select(…).eq(…).maybeSingle(), select() projects the fixture to the
// columns asked for, and every call is recorded, writes included.
//
// vi.hoisted for the same reason as tests/unit/webhook-suggest.test.ts.
const { reply, calls, storeAccounts, syncAndStore, afterFns } = vi.hoisted(() => ({
  reply: { value: { data: null as unknown, error: null as unknown } },
  calls: [] as unknown[][],
  storeAccounts: vi.fn(),
  syncAndStore: vi.fn(),
  afterFns: [] as (() => unknown)[],
}))

const project = (row: unknown, cols: string) =>
  row && typeof row === 'object'
    ? Object.fromEntries(
        cols.split(',').map((c) => c.trim()).filter((c) => c in row).map((c) => [c, (row as Record<string, unknown>)[c]])
      )
    : row

vi.mock('next/server', async (orig) => ({
  ...(await orig<typeof import('next/server')>()),
  after: (fn: () => unknown) => {
    afterFns.push(fn)
  },
}))
vi.mock('@/lib/category-suggest', () => ({ suggestCategories: async () => ({ suggested: 0 }) }))
vi.mock('@/lib/ingest', () => ({ storeAccounts, syncAndStore }))
vi.mock('@/lib/crypto', () => ({ decrypt: () => 'access-token' }))
vi.mock('@/lib/plaid', () => ({ plaidEnv: 'production' }))
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      calls.push(['from', table])
      return {
        select: (cols: string) => {
          calls.push(['select', cols])
          return {
            eq: (col: string, value: unknown) => {
              calls.push(['eq', col, value])
              return {
                maybeSingle: () => {
                  calls.push(['maybeSingle'])
                  return Promise.resolve({ ...reply.value, data: project(reply.value.data, cols) })
                },
              }
            },
          }
        },
        update: (payload: unknown) => {
          calls.push(['update', payload])
          return {
            eq: (col: string, value: unknown) => {
              calls.push(['eq', col, value])
              return Promise.resolve({ error: null })
            },
          }
        },
      }
    },
  },
}))

import { POST } from '@/app/api/plaid/webhook/route'

const ITEM = {
  id: 'item-1',
  household_id: 'hh-7',
  access_token_encrypted: 'cipher',
  cursor: null,
  products: ['transactions'],
  status: 'ok',
  plaid_env: 'production',
  institution_name: 'Capital One',
}

const READ = [
  ['from', 'plaid_items'],
  ['select', 'id, household_id, access_token_encrypted, cursor, products, status, plaid_env'],
  ['eq', 'item_id', 'plaid-item-1'],
  ['maybeSingle'],
]

function hook(body: Record<string, unknown>) {
  return new Request('http://localhost/api/plaid/webhook?key=s3cret', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ item_id: 'plaid-item-1', ...body }),
  })
}

const KINDS = [
  ['new transactions', { webhook_type: 'TRANSACTIONS', webhook_code: 'DEFAULT_UPDATE' }],
  ['a broken login', { webhook_type: 'ITEM', webhook_code: 'ERROR', error: { error_code: 'ITEM_LOGIN_REQUIRED' } }],
] as const

beforeEach(() => {
  vi.stubEnv('PLAID_WEBHOOK_SECRET', 's3cret')
  calls.length = 0
  afterFns.length = 0
  storeAccounts.mockReset().mockResolvedValue(undefined)
  syncAndStore.mockReset().mockResolvedValue({ added: 1, modified: 0, removed: 0 })
  reply.value = { data: ITEM, error: null }
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('POST /api/plaid/webhook: the item read (#91)', () => {
  it.each(KINDS)('answers 500 for %s when the item read fails, so Plaid delivers it again', async (_kind, body) => {
    reply.value = { data: null, error: { message: 'canceling statement due to statement timeout', code: '57014' } }
    const res = await POST(hook(body))
    expect(res.status).toBe(500)
    // No database text in the answer.
    expect(await res.json()).toEqual({ error: 'could not read the item' })
    // Nothing acted on: no status written, no sync, no suggestion run.
    expect(calls).toEqual(READ)
    expect(storeAccounts).not.toHaveBeenCalled()
    expect(syncAndStore).not.toHaveBeenCalled()
    expect(afterFns).toHaveLength(0)
  })

  // With context, so the log says which delivery failed and why. Exactly these fields, so nothing
  // else (a token, the request body) rides along.
  it('logs the failed read with the item and the webhook it was for', async () => {
    reply.value = { data: null, error: { message: 'canceling statement due to statement timeout', code: '57014' } }
    await POST(hook({ webhook_type: 'TRANSACTIONS', webhook_code: 'DEFAULT_UPDATE' }))
    expect(console.error).toHaveBeenCalledExactlyOnceWith('[plaid] webhook item read failed', {
      item_id: 'plaid-item-1',
      webhook_type: 'TRANSACTIONS',
      webhook_code: 'DEFAULT_UPDATE',
      code: '57014',
      message: 'canceling statement due to statement timeout',
    })
  })

  // Plaid stops retrying on a 200, which is right for an item that is not ours to act on.
  it.each([
    ['unknown here', null],
    ['from another Plaid environment', { ...ITEM, plaid_env: 'sandbox' }],
  ])('still acknowledges an item %s with a 200, and acts on nothing', async (_name, item) => {
    reply.value = { data: item, error: null }
    const res = await POST(hook({ webhook_type: 'TRANSACTIONS', webhook_code: 'DEFAULT_UPDATE' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(calls).toEqual(READ)
    expect(storeAccounts).not.toHaveBeenCalled()
    expect(console.error).not.toHaveBeenCalled()
  })

  it('still syncs an item it can read', async () => {
    const res = await POST(hook({ webhook_type: 'TRANSACTIONS', webhook_code: 'DEFAULT_UPDATE' }))
    expect(res.status).toBe(200)
    expect(calls).toEqual(READ)
    expect(storeAccounts).toHaveBeenCalledExactlyOnceWith('hh-7', 'item-1', 'access-token')
    expect(syncAndStore).toHaveBeenCalledExactlyOnceWith({ id: 'item-1', household_id: 'hh-7', access_token: 'access-token', cursor: null })
  })

  it('still marks an item it can read as needing a reconnect', async () => {
    const res = await POST(hook({ webhook_type: 'ITEM', webhook_code: 'ERROR', error: { error_code: 'ITEM_LOGIN_REQUIRED' } }))
    expect(res.status).toBe(200)
    expect(calls).toEqual([
      ...READ,
      ['from', 'plaid_items'],
      ['update', { status: 'needs_reconnect', status_detail: 'ITEM_LOGIN_REQUIRED' }],
      ['eq', 'id', 'item-1'],
    ])
  })
})
