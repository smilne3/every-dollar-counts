import { describe, it, expect, vi, beforeEach } from 'vitest'

// app/api/transactions/categorize/route.ts is the ONLY writer of user_category. Until #98 it wrote
// whatever it was handed after checking nothing but auth, so both of the guards asserted here were
// enforced by the UI alone — TransactionRow and, since #96, TransactionCard's sheet. Every new
// surface had to remember them independently, and the mobile pass has four more stages to add.
// Same shape as tests/unit/reimbursable-route.test.ts: mock @/lib/supabase/server, build a real
// Request, call the exported handler directly.
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}))

import { createClient } from '@/lib/supabase/server'
import { POST } from '@/app/api/transactions/categorize/route'

type ReadResult = { data: Record<string, unknown> | null; error: { message: string } | null }
type ListResult = { data: { name: string }[] | null; error: { message: string } | null }
type UpdateResult = { data: unknown; error: { message: string } | null }

// The route touches two tables, so unlike the reimbursable mock this one is table-aware:
//   transactions: from(...).select(...).eq(...).maybeSingle()  and  from(...).update(...).eq(...)
//   categories:   from(...).select(...)                        (awaited directly, no filter)
function makeSupabase({
  user = { id: 'user-1' } as { id: string } | null,
  readResult = { data: null, error: null } as ReadResult,
  categories = { data: [{ name: 'Food & Drink' }, { name: 'Shopping' }], error: null } as ListResult,
  updateResult = { data: null, error: null } as UpdateResult,
  onUpdate,
}: {
  user?: { id: string } | null
  readResult?: ReadResult
  categories?: ListResult
  updateResult?: UpdateResult
  onUpdate?: (payload: Record<string, unknown>) => void
} = {}) {
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user } }),
    },
    from: vi.fn((table: string) => {
      if (table === 'categories') {
        return { select: vi.fn().mockResolvedValue(categories) }
      }
      return {
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
      }
    }),
  }
}

function postRequest(body: unknown) {
  return new Request('http://localhost/api/transactions/categorize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const baseTxn = {
  id: 'txn-1',
  pfc_detailed: null as string | null,
  user_category: null as string | null,
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asClient = (s: ReturnType<typeof makeSupabase>) => s as any

describe('POST /api/transactions/categorize', () => {
  beforeEach(() => {
    vi.mocked(createClient).mockReset()
  })

  it('refuses an unauthenticated caller with 401', async () => {
    vi.mocked(createClient).mockResolvedValue(asClient(makeSupabase({ user: null })))
    const res = await POST(postRequest({ transactionId: 'txn-1', category: 'Shopping' }))
    expect(res.status).toBe(401)
  })

  // Fail CLOSED, exactly as /api/reimbursable does: "the query failed" and "no such transaction"
  // are different facts, and a read error must never be mistaken for permission to write.
  it('fails closed with 500, not 404, when the transaction read errors', async () => {
    vi.mocked(createClient).mockResolvedValue(
      asClient(makeSupabase({ readResult: { data: null, error: { message: 'connection reset' } } }))
    )
    const res = await POST(postRequest({ transactionId: 'txn-1', category: 'Shopping' }))
    expect(res.status).toBe(500)
    expect(res.status).not.toBe(404)
  })

  it('returns 404 when the transaction does not exist', async () => {
    vi.mocked(createClient).mockResolvedValue(
      asClient(makeSupabase({ readResult: { data: null, error: null } }))
    )
    const res = await POST(postRequest({ transactionId: 'nope', category: 'Shopping' }))
    expect(res.status).toBe(404)
  })

  // The #98 guard. isCreditCardPayment is `!user_category && pfc_detailed === ...`, so writing ANY
  // override here flips that predicate false for good and re-enters BOTH legs of the payment into
  // every total: measured on a real row, September spending went from $3,949.16 to -$3,917.53.
  it('refuses to categorize a credit-card payment with 400', async () => {
    let captured: Record<string, unknown> | null = null
    vi.mocked(createClient).mockResolvedValue(
      asClient(
        makeSupabase({
          readResult: {
            data: { ...baseTxn, pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', user_category: null },
            error: null,
          },
          onUpdate: (payload) => {
            captured = payload
          },
        })
      )
    )
    const res = await POST(postRequest({ transactionId: 'txn-1', category: 'Shopping' }))
    expect(res.status).toBe(400)
    // The status alone would pass even if the write had already happened.
    expect(captured).toBeNull()
  })

  // The override-wins contract (lib/categories.ts) is deliberate: once a human has said what this
  // row is, respect it. Only an AUTO-categorized card payment is refused, so a legacy override
  // stays correctable rather than frozen.
  it('allows a card payment that the user has already overridden', async () => {
    vi.mocked(createClient).mockResolvedValue(
      asClient(
        makeSupabase({
          readResult: {
            data: {
              ...baseTxn,
              pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT',
              user_category: 'Shopping',
            },
            error: null,
          },
        })
      )
    )
    const res = await POST(postRequest({ transactionId: 'txn-1', category: 'Food & Drink' }))
    expect(res.status).toBe(200)
  })

  // effectiveCategory returns user_category verbatim, so an unvalidated string becomes its own
  // spending bucket — absent from nonSpendingNames AND transferNames, counted as real spending.
  it('refuses a category that is not one of the household categories', async () => {
    let captured: Record<string, unknown> | null = null
    vi.mocked(createClient).mockResolvedValue(
      asClient(
        makeSupabase({
          readResult: { data: baseTxn, error: null },
          onUpdate: (payload) => {
            captured = payload
          },
        })
      )
    )
    const res = await POST(postRequest({ transactionId: 'txn-1', category: 'Not A Category' }))
    expect(res.status).toBe(400)
    expect(captured).toBeNull()
  })

  it('fails closed with 500 when the category list cannot be read', async () => {
    vi.mocked(createClient).mockResolvedValue(
      asClient(
        makeSupabase({
          readResult: { data: baseTxn, error: null },
          categories: { data: null, error: { message: 'connection reset' } },
        })
      )
    )
    const res = await POST(postRequest({ transactionId: 'txn-1', category: 'Shopping' }))
    expect(res.status).toBe(500)
  })

  it('writes a category that the household actually has', async () => {
    let captured: Record<string, unknown> | null = null
    vi.mocked(createClient).mockResolvedValue(
      asClient(
        makeSupabase({
          readResult: { data: baseTxn, error: null },
          onUpdate: (payload) => {
            captured = payload
          },
        })
      )
    )
    const res = await POST(postRequest({ transactionId: 'txn-1', category: 'Shopping' }))
    expect(res.status).toBe(200)
    expect(captured).toEqual({ user_category: 'Shopping' })
  })

  // 'Uncategorized' is a DISPLAY sentinel from effectiveCategory, never a row in `categories` —
  // but CategoryPicker deliberately offers it whenever it is the current value. Validating it like
  // a real name would 400 on an option the UI itself presents; writing it literally would create
  // the phantom bucket above. Choosing it means "no override".
  it('clears the override when Uncategorized is chosen, rather than refusing it', async () => {
    let captured: Record<string, unknown> | null = null
    vi.mocked(createClient).mockResolvedValue(
      asClient(
        makeSupabase({
          readResult: { data: { ...baseTxn, user_category: 'Shopping' }, error: null },
          onUpdate: (payload) => {
            captured = payload
          },
        })
      )
    )
    const res = await POST(postRequest({ transactionId: 'txn-1', category: 'Uncategorized' }))
    expect(res.status).toBe(200)
    expect(captured).toEqual({ user_category: null })
  })

  it('clears the override when the category is empty', async () => {
    let captured: Record<string, unknown> | null = null
    vi.mocked(createClient).mockResolvedValue(
      asClient(
        makeSupabase({
          readResult: { data: { ...baseTxn, user_category: 'Shopping' }, error: null },
          onUpdate: (payload) => {
            captured = payload
          },
        })
      )
    )
    const res = await POST(postRequest({ transactionId: 'txn-1', category: '' }))
    expect(res.status).toBe(200)
    expect(captured).toEqual({ user_category: null })
  })
})
