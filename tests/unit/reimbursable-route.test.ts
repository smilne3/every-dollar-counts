import { describe, it, expect, vi, beforeEach } from 'vitest'

// app/api/reimbursable/route.ts is the ONLY writer of reimbursable_amount / reimbursable_note. It
// holds three load-bearing guards — refuse a credit-card payment (#31), refuse a `removed`
// transaction, and fail CLOSED (500, never a misleading 404 or a silent success) on a read error —
// none of which had any regression protection before this test. There are no route tests anywhere
// else in this repo; this establishes the pattern: mock @/lib/supabase/server the same shape
// tests/unit/ingest-reimbursable.test.ts mocks @/lib/supabase/admin, build a real Request, and call
// the exported handler directly.
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}))

import { createClient } from '@/lib/supabase/server'
import { PATCH } from '@/app/api/reimbursable/route'

type ReadResult = { data: Record<string, unknown> | null; error: { message: string } | null }
type UpdateResult = { data: unknown; error: { message: string } | null }

// A minimal stand-in for the chunk of the supabase-js chain this route actually calls:
//   auth.getUser()
//   from(...).select(...).eq(...).maybeSingle()
//   from(...).update(...).eq(...)
// Nothing else on the real client is touched by this route, so nothing else is mocked.
function makeSupabase({
  user = { id: 'user-1' } as { id: string } | null,
  readResult = { data: null, error: null } as ReadResult,
  updateResult = { data: null, error: null } as UpdateResult,
  onUpdate,
}: {
  user?: { id: string } | null
  readResult?: ReadResult
  updateResult?: UpdateResult
  onUpdate?: (payload: Record<string, unknown>) => void
} = {}) {
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user } }),
    },
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn().mockResolvedValue(readResult),
        })),
      })),
      update: vi.fn((payload: Record<string, unknown>) => {
        onUpdate?.(payload)
        return {
          eq: vi.fn().mockResolvedValue(updateResult),
        }
      }),
    })),
  }
}

function patchRequest(body: unknown) {
  return new Request('http://localhost/api/reimbursable', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const baseTxn = {
  id: 'txn-1',
  amount: 900,
  removed: false,
  pfc_detailed: null as string | null,
  user_category: null as string | null,
}

describe('PATCH /api/reimbursable', () => {
  beforeEach(() => {
    vi.mocked(createClient).mockReset()
  })

  it('refuses an unauthenticated caller with 401', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(createClient).mockResolvedValue(makeSupabase({ user: null }) as any)
    const res = await PATCH(patchRequest({ transactionId: 'txn-1', amount: 500, note: null }))
    expect(res.status).toBe(401)
  })

  // Fail CLOSED: "the query failed" and "no such transaction" are different facts, and conflating
  // them (returning 404) would let a transient read error look like an invalid request instead of
  // the server problem it is.
  it('fails closed with 500, not 404, when the read errors', async () => {
    vi.mocked(createClient).mockResolvedValue(
      makeSupabase({
        readResult: { data: null, error: { message: 'connection reset' } },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any
    )
    const res = await PATCH(patchRequest({ transactionId: 'txn-1', amount: 500, note: null }))
    expect(res.status).toBe(500)
    expect(res.status).not.toBe(404)
  })

  // `removed` is a soft flag (a Plaid repost), not a delete. A mark written to a removed row would be
  // unreachable while still counting toward what you're owed.
  it('refuses a removed transaction with 400', async () => {
    vi.mocked(createClient).mockResolvedValue(
      makeSupabase({
        readResult: { data: { ...baseTxn, removed: true }, error: null },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any
    )
    const res = await PATCH(patchRequest({ transactionId: 'txn-1', amount: 500, note: null }))
    expect(res.status).toBe(400)
  })

  // Guards #31: a credit-card payment is already excluded from spending, so marking it reduces
  // nothing while still inflating what you're owed.
  it('refuses a credit-card payment with 400', async () => {
    vi.mocked(createClient).mockResolvedValue(
      makeSupabase({
        readResult: {
          data: { ...baseTxn, pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', user_category: null },
          error: null,
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any
    )
    const res = await PATCH(patchRequest({ transactionId: 'txn-1', amount: 500, note: null }))
    expect(res.status).toBe(400)
  })

  it('marks a valid transaction, writing the clamped amount', async () => {
    let captured: Record<string, unknown> | null = null
    vi.mocked(createClient).mockResolvedValue(
      makeSupabase({
        readResult: { data: baseTxn, error: null },
        onUpdate: (payload) => {
          captured = payload
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any
    )
    // $5,000 requested on a $900 transaction — must be clamped to 900, never stored raw.
    const res = await PATCH(patchRequest({ transactionId: 'txn-1', amount: 5000, note: 'Dave' }))
    expect(res.status).toBe(200)
    expect(captured).toEqual({ reimbursable_amount: 900, reimbursable_note: 'Dave' })
  })
})
