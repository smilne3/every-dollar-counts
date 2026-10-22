import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Plaid's LOGIN_REPAIRED webhook (#194): a bank's login was fixed outside this app's update flow,
// for example in another app that uses Plaid. The webhook ignored it, so the bank stayed
// needs_reconnect: "Connection lost" in Settings, skipped by Refresh, "isn't syncing" on every money
// page and its savings average hidden, until someone pressed Reconnect.
//
// The stand-in is tests/unit/webhook-recovery.test.ts's: strict, and holding the stored rows as
// Postgres would. The read resolves only through .from('plaid_items').select(…).eq(…).maybeSingle()
// and returns only the columns asked for. A write lands when it is awaited: it is recorded then,
// with its filters, and changes only the rows they all match at that moment. A write can be refused,
// or go unanswered as postgrest-js reports a request lost in flight (#173), and then changes
// nothing. So each test reads the bank as it ends up. `meanwhile` runs once the read has answered,
// to record a status between the read and the write.
//
// vi.hoisted for the same reason as tests/unit/webhook-suggest.test.ts.
const { stored, writes, writeReply, meanwhile, storeAccounts, syncAndStore } = vi.hoisted(() => ({
  stored: { rows: [] as Record<string, unknown>[] },
  writes: [] as unknown[][],
  // What a status write resolves to, in place of a write that succeeds.
  writeReply: { value: null as { error: { code: string; message: string } | null } | null },
  meanwhile: { fn: null as (() => void) | null },
  storeAccounts: vi.fn(),
  syncAndStore: vi.fn(),
}))

const project = (row: Record<string, unknown>, cols: string) =>
  Object.fromEntries(cols.split(',').map((c) => c.trim()).filter((c) => c in row).map((c) => [c, row[c]]))

// A write as the stand-in takes it: narrowed by .eq(), and landing when awaited.
type Write = PromiseLike<unknown> & { eq: (col: string, value: unknown) => Write }

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
              const data = row ? project(row, cols) : null
              meanwhile.fn?.()
              return { data, error: null }
            },
          }),
        }),
        update: (values: Record<string, unknown>) => {
          const filters: [string, string, unknown][] = []
          const write: Write = {
            eq: (col, value) => {
              filters.push(['eq', col, value])
              return write
            },
            then: (resolve, reject) => {
              writes.push(['update', values, ...filters.flat()])
              const reply = writeReply.value ?? { data: null, error: null, status: 204 }
              if (!reply.error) {
                for (const r of stored.rows) if (filters.every(([, col, value]) => r[col] === value)) Object.assign(r, values)
              }
              return Promise.resolve(reply).then(resolve, reject)
            },
          }
          return write
        },
      }
    },
  },
}))

import { POST } from '@/app/api/plaid/webhook/route'
import { NO_ANSWER } from '../stubs/no-answer'

// Capital One's login broke, and was fixed in another app that uses Plaid.
const bank = (over: Record<string, unknown> = {}) => ({
  id: 'item-1',
  item_id: 'plaid-item-1',
  household_id: 'hh-7',
  access_token_encrypted: 'cipher',
  cursor: 'cursor-1',
  products: ['transactions'],
  status: 'needs_reconnect',
  status_detail: 'ITEM_LOGIN_REQUIRED',
  plaid_env: 'production',
  institution_name: 'Capital One',
  ...over,
})
// Another of the household's banks, its login broken too. The webhook isn't about it.
const CHASE = bank({ id: 'item-2', item_id: 'plaid-item-2', institution_name: 'Chase' })
const REPAIRED_BANK = bank({ status: 'ok', status_detail: null })

const REPAIRED = { webhook_type: 'ITEM', webhook_code: 'LOGIN_REPAIRED' }
const CLEARED = [
  'update',
  { status: 'ok', status_detail: null },
  'eq', 'id', 'item-1',
  'eq', 'status', 'needs_reconnect',
  'eq', 'status_detail', 'ITEM_LOGIN_REQUIRED',
]
const PULLED = { id: 'item-1', household_id: 'hh-7', access_token: 'access-token', cursor: 'cursor-1' }

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
  meanwhile.fn = null
  storeAccounts.mockReset().mockResolvedValue(undefined)
  syncAndStore.mockReset().mockResolvedValue({ added: 3, modified: 0, removed: 0 })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('POST /api/plaid/webhook: a login repaired outside this app (#194)', () => {
  it('marks a bank whose login broke ok, and only that bank, then pulls what it missed', async () => {
    const res = await POST(hook(REPAIRED))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(stored.rows).toEqual([REPAIRED_BANK, CHASE])
    expect(writes).toEqual([CLEARED])
    expect(storeAccounts).toHaveBeenCalledExactlyOnceWith('hh-7', 'item-1', 'access-token')
    expect(syncAndStore).toHaveBeenCalledExactlyOnceWith(PULLED)
    expect(console.error).not.toHaveBeenCalled()
  })

  // An investment or loan bank never syncs transactions, here as on Refresh (lib/sync-policy.ts).
  it('pulls only the balances of a bank that syncs no transactions', async () => {
    stored.rows = [bank({ products: ['investments'] }), { ...CHASE }]
    await POST(hook(REPAIRED))
    expect(stored.rows).toEqual([bank({ products: ['investments'], status: 'ok', status_detail: null }), CHASE])
    expect(storeAccounts).toHaveBeenCalledExactlyOnceWith('hh-7', 'item-1', 'access-token')
    expect(syncAndStore).not.toHaveBeenCalled()
  })

  // A failed pull never fails the webhook: Plaid would only send it again. The login works, so the
  // bank stays ok, as after Reconnect, and the next Refresh pulls what's missing.
  it.each([
    ['its balances', storeAccounts],
    ['its transactions', syncAndStore],
  ])("still marks the bank ok, and answers ok, when %s can't be pulled", async (_what, pull) => {
    pull.mockRejectedValue({ response: { status: 400, data: { error_code: 'INSTITUTION_DOWN' } } })
    const res = await POST(hook(REPAIRED))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(stored.rows).toEqual([REPAIRED_BANK, CHASE])
    expect(console.error).toHaveBeenCalledExactlyOnceWith('[plaid] webhook sync failed', 'item-1', 'http=400 code=INSTITUTION_DOWN')
  })

  // Lost, this write leaves the bank saying to reconnect, as it did before, and reconnecting is
  // free; the needs_reconnect write's loss would hide a broken bank instead. So it is only logged,
  // with exactly these fields so the token can't ride along, and the bank is still pulled: its login
  // works.
  it.each([
    ['refused', { data: null, error: { code: '42501', message: 'permission denied for table plaid_items' }, status: 403 }],
    ['never answered', NO_ANSWER],
  ])('only logs a status write that is %s, still pulls the bank, and answers ok', async (_how, reply) => {
    writeReply.value = reply
    const res = await POST(hook(REPAIRED))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(writes).toEqual([CLEARED])
    expect(stored.rows).toEqual([bank(), CHASE])
    expect(console.error).toHaveBeenCalledExactlyOnceWith('[plaid] webhook status write failed', {
      item_id: 'plaid-item-1',
      webhook_type: 'ITEM',
      webhook_code: 'LOGIN_REPAIRED',
      code: reply.error.code,
      message: reply.error.message,
    })
    expect(storeAccounts).toHaveBeenCalledExactlyOnceWith('hh-7', 'item-1', 'access-token')
    expect(syncAndStore).toHaveBeenCalledExactlyOnceWith(PULLED)
  })

  // A broken login is all Plaid says has ended. A bank not marked for one keeps its status: one
  // reconnected here, one that didn't respond on a Refresh since, one locked at the bank. Plaid has
  // said its login works, so it is still pulled.
  it.each([
    ['was reconnected here', 'ok', null],
    ["didn't respond on a Refresh since", 'temporarily_unavailable', 'INSTITUTION_DOWN'],
    ['is locked at the bank', 'action_at_bank', 'ITEM_LOCKED'],
  ])('leaves a bank that %s as it is, and still pulls it', async (_why, status, status_detail) => {
    stored.rows = [bank({ status, status_detail }), { ...CHASE }]
    const res = await POST(hook(REPAIRED))
    expect(await res.json()).toEqual({ ok: true })
    expect(stored.rows).toEqual([bank({ status, status_detail }), CHASE])
    expect(storeAccounts).toHaveBeenCalledExactlyOnceWith('hh-7', 'item-1', 'access-token')
    expect(syncAndStore).toHaveBeenCalledExactlyOnceWith(PULLED)
    expect(console.error).not.toHaveBeenCalled()
  })

  // Nor one marked for a reason a repaired login doesn't end. A login Plaid has said will expire
  // still will, and access revoked at the bank is still revoked. Only a webhook says the first, and
  // for a balances-only bank the second, so cleared here, the warning would be gone for good.
  it.each([
    ['a login about to expire', 'PENDING_EXPIRATION'],
    ['a bank about to be disconnected', 'PENDING_DISCONNECT'],
    ['access revoked at the bank', 'USER_ACCOUNT_REVOKED'],
  ])('keeps %s marked', async (_what, status_detail) => {
    stored.rows = [bank({ status_detail }), { ...CHASE }]
    const res = await POST(hook(REPAIRED))
    expect(await res.json()).toEqual({ ok: true })
    expect(stored.rows).toEqual([bank({ status_detail }), CHASE])
  })

  // Postgres applies the filters when the write lands, so a status recorded after the read stands:
  // here an ITEM webhook for the same bank lands between the two. Plaid sends PENDING_DISCONNECT
  // once.
  it('leaves a status recorded between the read and the write alone', async () => {
    meanwhile.fn = () => Object.assign(stored.rows[0], { status_detail: 'PENDING_DISCONNECT' })
    const res = await POST(hook(REPAIRED))
    expect(await res.json()).toEqual({ ok: true })
    expect(stored.rows).toEqual([bank({ status_detail: 'PENDING_DISCONNECT' }), CHASE])
  })

  // Nothing else says the login works again.
  it.each([
    ['another ITEM webhook', { webhook_type: 'ITEM', webhook_code: 'NEW_ACCOUNTS_AVAILABLE' }],
    ['the same code under another webhook type', { webhook_type: 'HOLDINGS', webhook_code: 'LOGIN_REPAIRED' }],
  ])('changes and pulls nothing for %s', async (_what, body) => {
    const res = await POST(hook(body))
    expect(await res.json()).toEqual({ ok: true })
    expect(stored.rows).toEqual([bank(), CHASE])
    expect(writes).toEqual([])
    expect(storeAccounts).not.toHaveBeenCalled()
    expect(syncAndStore).not.toHaveBeenCalled()
  })

  // Only a bank of this app's Plaid environment, as for every other webhook.
  it.each([
    ['from the other Plaid environment', bank({ plaid_env: 'sandbox' })],
    ['unknown here', bank({ item_id: 'plaid-item-9' })],
  ])('changes and pulls nothing for a bank %s', async (_what, row) => {
    stored.rows = [{ ...row }, { ...CHASE }]
    const res = await POST(hook(REPAIRED))
    expect(await res.json()).toEqual({ ok: true })
    expect(stored.rows).toEqual([row, CHASE])
    expect(writes).toEqual([])
    expect(storeAccounts).not.toHaveBeenCalled()
    expect(syncAndStore).not.toHaveBeenCalled()
  })
})
