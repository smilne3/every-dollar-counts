import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// app/api/transactions/categorize/route.ts is the only route that sets an arbitrary override on a
// single transaction. Until #98 it wrote whatever it was handed after checking nothing but auth, so
// both of the guards asserted here were enforced by the UI alone — TransactionRow and, since #96,
// TransactionCard's sheet. Every new surface had to remember them independently, and stages 2-5 of
// the mobile pass are still open.
//
// Same shape as tests/unit/reimbursable-route.test.ts, with two differences that exist because a
// review mutation-tested the first draft of this file and three killed guards still passed:
//   - select() PROJECTS the fixture down to the columns actually requested, so narrowing the query
//     starves isCreditCardPayment exactly as it would in production instead of being papered over
//     by a fixture that always carries every field.
//   - update() is reachable only through .eq(), so an unscoped update — which would rewrite every
//     row RLS lets the caller touch — cannot resolve at all.
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}))

import { createClient } from '@/lib/supabase/server'
import { POST } from '@/app/api/transactions/categorize/route'

type Row = Record<string, unknown>
type ReadResult = { data: Row | null; error: { message: string } | null }
type ListResult = { data: { name: string }[] | null; error: { message: string } | null }
type UpdateResult = { data: unknown; error: { message: string } | null; count: number | null }

// Return only the columns the caller asked for. `select('id')` must not hand back pfc_detailed.
function project(result: ReadResult, columns: string): ReadResult {
  if (!result.data) return result
  const wanted = columns.split(',').map((c) => c.trim())
  const data: Row = {}
  for (const key of wanted) if (key in result.data) data[key] = result.data[key]
  return { ...result, data }
}

function makeSupabase({
  user = { id: 'user-1' } as { id: string } | null,
  readResult = { data: null, error: null } as ReadResult,
  categories = { data: [{ name: 'Food & Drink' }, { name: 'Shopping' }], error: null } as ListResult,
  updateResult = { data: null, error: null, count: 1 } as UpdateResult,
  onSelect,
  onUpdate,
}: {
  user?: { id: string } | null
  readResult?: ReadResult
  categories?: ListResult
  updateResult?: UpdateResult
  onSelect?: (columns: string) => void
  onUpdate?: (payload: Row, filter: Row, options: Row | undefined) => void
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
        select: vi.fn((columns: string) => {
          onSelect?.(columns)
          return {
            eq: vi.fn(() => ({
              maybeSingle: vi.fn().mockResolvedValue(project(readResult, columns)),
            })),
          }
        }),
        // Deliberately NOT a thenable. The route must narrow the update with .eq() to get a result
        // at all; `await` on this bare object would yield it verbatim and fail every assertion.
        update: vi.fn((payload: Row, options: Row | undefined) => ({
          eq: vi.fn((column: string, value: unknown) => {
            onUpdate?.(payload, { [column]: value }, options)
            return Promise.resolve(updateResult)
          }),
        })),
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
    // The route logs the database's words on the two failure paths below. Silenced so a passing run
    // stays clean; the assertions check the RESPONSE, which is the part the user sees.
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
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

  // Without these two columns isCreditCardPayment evaluates `!undefined && undefined === '...'`,
  // which is false for every row — the #98 guard silently stops guarding. A narrowed select is a
  // one-word edit, so name the requirement rather than leaving it to the fixture.
  it('reads the columns the card-payment guard depends on', async () => {
    let columns = ''
    vi.mocked(createClient).mockResolvedValue(
      asClient(
        makeSupabase({
          readResult: { data: baseTxn, error: null },
          onSelect: (c) => {
            columns = c
          },
        })
      )
    )
    await POST(postRequest({ transactionId: 'txn-1', category: 'Shopping' }))
    expect(columns).toContain('pfc_detailed')
    expect(columns).toContain('user_category')
  })

  // The #98 guard. isCreditCardPayment is `!user_category && pfc_detailed === ...`, so writing ANY
  // override here flips that predicate false for good and re-enters the leg you categorized into
  // the totals: measured on a real row, September spending went from $3,949.16 to -$3,917.53.
  it('refuses to categorize a credit-card payment with 400', async () => {
    let captured: Row | null = null
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
  // stays correctable rather than frozen — and the correction must actually be written.
  it('allows a card payment that the user has already overridden', async () => {
    let captured: Row | null = null
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
          onUpdate: (payload) => {
            captured = payload
          },
        })
      )
    )
    const res = await POST(postRequest({ transactionId: 'txn-1', category: 'Food & Drink' }))
    expect(res.status).toBe(200)
    expect(captured).toEqual({ user_category: 'Food & Drink' })
  })

  // effectiveCategory returns user_category verbatim, so an unvalidated string becomes its own
  // spending bucket — absent from nonSpendingNames AND transferNames, counted as real spending.
  it('refuses a category that is not one of the household categories', async () => {
    let captured: Row | null = null
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

  it('writes a category that the household actually has, to that row alone', async () => {
    let captured: Row | null = null
    let filter: Row | null = null
    let options: Row | undefined
    vi.mocked(createClient).mockResolvedValue(
      asClient(
        makeSupabase({
          readResult: { data: baseTxn, error: null },
          onUpdate: (p, f, o) => {
            captured = p
            filter = f
            options = o
          },
        })
      )
    )
    const res = await POST(postRequest({ transactionId: 'txn-1', category: 'Shopping' }))
    expect(res.status).toBe(200)
    expect(captured).toEqual({ user_category: 'Shopping' })
    // An update that is not narrowed to this id rewrites every row RLS lets the caller reach.
    expect(filter).toEqual({ id: 'txn-1' })
    // Supabase sends no count header unless asked, and without a count a write that matched nothing
    // is indistinguishable from a write that worked. See the zero-row test below.
    expect(options).toEqual({ count: 'exact' })
  })

  // 'Uncategorized' is a DISPLAY sentinel from effectiveCategory, never a row in `categories` —
  // but CategoryPicker keeps it in the option list whenever it is the current value. Validating it
  // like a real name would reject an option that is on screen; writing it literally would create
  // the phantom bucket above. Choosing it means "no override".
  it('clears the override when Uncategorized is chosen, rather than refusing it', async () => {
    let captured: Row | null = null
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
    let captured: Row | null = null
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

  // Without the trim, a padded name fails validation against a list that plainly contains it.
  it('accepts a category with surrounding whitespace', async () => {
    let captured: Row | null = null
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
    const res = await POST(postRequest({ transactionId: 'txn-1', category: '  Shopping  ' }))
    expect(res.status).toBe(200)
    expect(captured).toEqual({ user_category: 'Shopping' })
  })

  // And without it, a cell of spaces is stored verbatim: a category whose name is invisible.
  it('treats a whitespace-only category as clearing the override', async () => {
    let captured: Row | null = null
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
    const res = await POST(postRequest({ transactionId: 'txn-1', category: '   ' }))
    expect(res.status).toBe(200)
    expect(captured).toEqual({ user_category: null })
  })

  // A write that fails must not report success. CategoryPicker keeps its optimistic value on a 200,
  // so a swallowed write error is #97 reproduced from the server side.
  it('reports a failed write as 500 rather than success', async () => {
    vi.mocked(createClient).mockResolvedValue(
      asClient(
        makeSupabase({
          readResult: { data: baseTxn, error: null },
          updateResult: { data: null, error: { message: 'deadlock detected' }, count: null },
        })
      )
    )
    const res = await POST(postRequest({ transactionId: 'txn-1', category: 'Shopping' }))
    expect(res.status).toBe(500)
    const body = await res.json()
    // The database's words are logged, not shown (app/api/manual-assets/route.ts:47-53).
    expect(body.error).not.toContain('deadlock')
  })

  // How #73 hid: no update policy, the write matched nothing, Supabase reported no error, and the
  // old value came back forever. The row count is the only thing that distinguishes the two.
  it('reports an update that matched no rows as 500 rather than success', async () => {
    vi.mocked(createClient).mockResolvedValue(
      asClient(
        makeSupabase({
          readResult: { data: baseTxn, error: null },
          updateResult: { data: null, error: null, count: 0 },
        })
      )
    )
    const res = await POST(postRequest({ transactionId: 'txn-1', category: 'Shopping' }))
    expect(res.status).toBe(500)
  })
})
