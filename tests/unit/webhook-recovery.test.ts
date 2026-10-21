import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The webhook's data-ready path marks a bank ok again once its sync succeeds, as Refresh does (#191).
// Only Refresh used to, so a bank whose data Plaid's webhooks kept bringing in stayed "isn't
// syncing", with its savings average hidden, until someone pressed it.
//
// The stand-in is strict, and holds the stored rows as Postgres would: the read resolves only
// through .from('plaid_items').select(…).eq(…).maybeSingle() and returns only the columns asked
// for; a write resolves only through .update(…).eq(…), is recorded, and changes only the rows that
// filter matches. A write can be refused, or go unanswered as postgrest-js reports a request lost in
// flight (#173), and then changes nothing. So each test reads the bank as it ends up.
//
// vi.hoisted for the same reason as tests/unit/webhook-suggest.test.ts.
const { stored, writes, writeReply, storeAccounts, syncAndStore } = vi.hoisted(() => ({
  stored: { rows: [] as Record<string, unknown>[] },
  writes: [] as unknown[][],
  // What a status write resolves to, in place of a write that succeeds.
  writeReply: { value: null as { error: { code: string; message: string } | null } | null },
  storeAccounts: vi.fn(),
  syncAndStore: vi.fn(),
}))

const project = (row: Record<string, unknown>, cols: string) =>
  Object.fromEntries(cols.split(',').map((c) => c.trim()).filter((c) => c in row).map((c) => [c, row[c]]))

vi.mock('next/server', async (orig) => ({
  ...(await orig<typeof import('next/server')>()),
  after: () => {},
}))
vi.mock('@/lib/category-suggest', () => ({ suggestCategories: async () => ({ suggested: 0 }) }))
vi.mock('@/lib/ingest', () => ({ storeAccounts, syncAndStore }))
vi.mock('@/lib/crypto', () => ({ decrypt: () => 'access-token' }))
vi.mock('@/lib/plaid', () => ({ plaidEnv: 'production' }))
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table !== 'plaid_items') throw new Error(`unexpected table ${table}`)
      return {
        select: (cols: string) => ({
          eq: (col: string, value: unknown) => ({
            maybeSingle: async () => {
              const row = stored.rows.find((r) => r[col] === value)
              return { data: row ? project(row, cols) : null, error: null }
            },
          }),
        }),
        update: (values: Record<string, unknown>) => ({
          eq: async (col: string, value: unknown) => {
            writes.push(['update', values, 'eq', col, value])
            const reply = writeReply.value ?? { data: null, error: null, status: 204 }
            if (!reply.error) for (const r of stored.rows) if (r[col] === value) Object.assign(r, values)
            return reply
          },
        }),
      }
    },
  },
}))

import { POST } from '@/app/api/plaid/webhook/route'
import { NO_ANSWER } from '../stubs/no-answer'

// Amex didn't respond on the last Refresh, which marked it.
const bank = (over: Record<string, unknown> = {}) => ({
  id: 'item-1',
  item_id: 'plaid-item-1',
  household_id: 'hh-7',
  access_token_encrypted: 'cipher',
  cursor: 'cursor-1',
  products: ['transactions'],
  status: 'temporarily_unavailable',
  status_detail: 'INSTITUTION_DOWN',
  plaid_env: 'production',
  institution_name: 'Amex',
  ...over,
})
// Another of the household's banks, not the one the webhook is about.
const CHASE = bank({ id: 'item-2', item_id: 'plaid-item-2', institution_name: 'Chase' })

const DATA_READY = { webhook_type: 'TRANSACTIONS', webhook_code: 'SYNC_UPDATES_AVAILABLE' }
const RECOVERED = ['update', { status: 'ok', status_detail: null }, 'eq', 'id', 'item-1']

function hook(body: Record<string, unknown>) {
  return new Request('http://localhost/api/plaid/webhook?key=s3cret', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ item_id: 'plaid-item-1', ...body }),
  })
}

beforeEach(() => {
  vi.stubEnv('PLAID_WEBHOOK_SECRET', 's3cret')
  stored.rows = [bank(), { ...CHASE }]
  writes.length = 0
  writeReply.value = null
  storeAccounts.mockReset().mockResolvedValue(undefined)
  syncAndStore.mockReset().mockResolvedValue({ added: 2, modified: 0, removed: 0 })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('POST /api/plaid/webhook: a bank that recovers (#191)', () => {
  it.each([
    ["didn't respond last time", 'temporarily_unavailable', 'INSTITUTION_DOWN'],
    ["couldn't be saved by this app", 'temporarily_unavailable', 'APP_ERROR'],
    ['needed something done at the bank', 'action_at_bank', 'ITEM_LOCKED'],
  ])('marks a bank that %s ok once its data-ready sync succeeds, and only that bank', async (_why, status, status_detail) => {
    stored.rows = [bank({ status, status_detail }), { ...CHASE }]
    const res = await POST(hook(DATA_READY))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(syncAndStore).toHaveBeenCalledExactlyOnceWith({ id: 'item-1', household_id: 'hh-7', access_token: 'access-token', cursor: 'cursor-1' })
    expect(stored.rows).toEqual([bank({ status: 'ok', status_detail: null }), CHASE])
    expect(writes).toEqual([RECOVERED])
    expect(console.error).not.toHaveBeenCalled()
  })

  // A failed sync never fails the webhook: Plaid would only send it again. The bank is still behind,
  // so it stays marked, and the banner and the average still say so.
  it.each([
    ['its balances', storeAccounts],
    ['its transactions', syncAndStore],
  ])("leaves a bank as it was when %s can't be pulled, and still answers ok", async (_what, pull) => {
    pull.mockRejectedValue({ response: { status: 400, data: { error_code: 'INSTITUTION_DOWN' } } })
    const res = await POST(hook(DATA_READY))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(stored.rows).toEqual([bank(), CHASE])
    expect(writes).toEqual([])
    expect(console.error).toHaveBeenCalledExactlyOnceWith('[plaid] webhook sync failed', 'item-1', 'http=400 code=INSTITUTION_DOWN')
  })

  // Only Reconnect clears a broken login. The webhook still stores its accounts, and a login Plaid
  // has said will expire works until it does, so marked ok here, its warning would go for good.
  it.each([
    ['a login about to expire', 'PENDING_EXPIRATION'],
    ['a broken login', 'ITEM_LOGIN_REQUIRED'],
  ])('never marks %s ok, though its accounts were stored', async (_what, status_detail) => {
    stored.rows = [bank({ status: 'needs_reconnect', status_detail }), { ...CHASE }]
    await POST(hook(DATA_READY))
    expect(storeAccounts).toHaveBeenCalledExactlyOnceWith('hh-7', 'item-1', 'access-token')
    expect(stored.rows).toEqual([bank({ status: 'needs_reconnect', status_detail }), CHASE])
    expect(writes).toEqual([])
  })

  // The usual delivery. Nothing to record, so nothing is written.
  it('writes nothing for a bank that is already ok', async () => {
    stored.rows = [bank({ status: 'ok', status_detail: null }), { ...CHASE }]
    await POST(hook(DATA_READY))
    expect(syncAndStore).toHaveBeenCalledOnce()
    expect(writes).toEqual([])
  })

  // As on Refresh: the data is in, and the next sync that succeeds writes the flag again. Exactly
  // these fields in the log, so the token cannot ride along.
  it.each([
    ['refused', { data: null, error: { code: '42501', message: 'permission denied for table plaid_items' }, status: 403 }],
    ['never answered', NO_ANSWER],
  ])('only logs a status write that is %s, and still answers ok', async (_how, reply) => {
    writeReply.value = reply
    const res = await POST(hook(DATA_READY))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(writes).toEqual([RECOVERED])
    expect(stored.rows).toEqual([bank(), CHASE])
    expect(console.error).toHaveBeenCalledExactlyOnceWith('[plaid] webhook status write failed', {
      item_id: 'plaid-item-1',
      webhook_type: 'TRANSACTIONS',
      webhook_code: 'SYNC_UPDATES_AVAILABLE',
      code: reply.error.code,
      message: reply.error.message,
    })
  })
})
