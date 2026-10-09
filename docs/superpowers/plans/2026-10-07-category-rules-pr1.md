# Category Learning, PR 1: One Honest Save Path — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make saving a category on a transaction honest and closed to card payments, so PRs 2–4 (rules, learning, Jev) build on a route and a picker that never lie about what was saved.

**Architecture:** No new subsystem. `lib/categories.ts` gains `isCardPaymentRow`, which tests `pfc_detailed` alone. `POST /api/transactions/categorize` is rewritten to the spec's §6.1 steps 1–7 and 9: it validates before touching the database, refuses removed rows and every card payment, puts its guards inside the UPDATE, answers 409 when the row changed underneath it, and logs each change. `CategoryPicker` treats only a JSON `{ ok: true }` as success, follows the server's value when it changes, and keeps its error on the picker's own line from `md` up. Both transaction surfaces show a card payment's existing pick as plain text instead of a picker the server would refuse. No behaviour changes for ordinary rows.

**Tech Stack:** Next.js 16 App Router route handler, Supabase (`@supabase/ssr` server client), React 19 client component, Tailwind v4, Vitest + Testing Library (jsdom).

**Spec:** `docs/superpowers/specs/2026-09-11-category-rules-design.md` (branch `28-category-rules`). This plan implements PR 1 of §10.1: §5.2's `lib/categories.ts` exports, §6.1 steps 1–7 and 9, §8.2 keyed on `value`, and the §8.1 card-payment cell on the existing `categoryName` prop.

## Global Constraints

- Every write is narrowed: `.update(…, { count: 'exact' })`, and a falsy `count` is never reported as success.
- The database's words are logged, never shown. Every message a person can see is written English.
- Card-payment test is `pfc_detailed === 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT'` **alone** (`isCardPaymentRow`), never `isCreditCardPayment`, in the route and on both surfaces.
- `isCreditCardPayment` keeps its exact behaviour; it still drives the totals and `presentTransaction`'s `isCC`.
- Clearing a pick is not supported (spec decision 7): an empty, whitespace-only or unknown category is a 400.
- A save succeeds only when `res.ok && !res.redirected` and the body parses as JSON with `ok: true`.
- The desktop row never grows a second line because of the picker (#50). The phone sheet keeps a full-width picker.
- No new dependencies. Run the full suite in both timezones before the PR: `npx vitest run` and `VITEST_TZ=America/Los_Angeles npx vitest run`.
- Every guard added gets a mutation check before the PR: revert it, see a test fail, restore (repo memory: green tests have hidden dead guards here before).

## Review Focus

1. **A signed-out phone.** `proxy.ts` redirects a signed-out `/api` call to `/login`, so `fetch` follows it and gets a 200 HTML page. The picker must roll back and say "Your session ended. Sign in again.", not show the new category as saved. (Task 3, redirected-200 test.)
2. **The other partner changed the row a moment earlier**, or Plaid removed it between page load and pick. The route must answer 409 or 400 with a readable message, and the picker must snap back to what the server has. (Task 2 zero-count and removed tests; Task 3 follow-server test.)
3. **A card payment someone filed by hand before this PR.** Today both surfaces offer a picker on it. After this PR the route refuses it, so the surfaces must not offer a control that always fails. (Task 4 tests on both surfaces.)
4. **An error on a phone.** The sheet's picker is full width; the new one-line wrapper must not shrink it beside the error. (Task 3 wrapper-classes test.)
5. **An older open tab sending "Uncategorized" or an empty category** (the old clearing behaviour). It must get a 400 with a readable message, and nothing must be written. (Task 2 tests.)

---

## File Structure

| File | Change | Responsibility |
| --- | --- | --- |
| `lib/categories.ts` | Modify | Export `CREDIT_CARD_PAYMENT_DETAILED` and add `isCardPaymentRow(pfcDetailed)`. |
| `tests/unit/categories.test.ts` | Modify | Pin `isCardPaymentRow`. |
| `app/api/transactions/categorize/route.ts` | Rewrite | Spec §6.1 steps 1–7, 9. |
| `tests/unit/categorize-route.test.ts` | Rewrite | A stand-in that enforces the new query shapes; the PR 1 list from spec §11. |
| `components/CategoryPicker.tsx` | Modify | Honest save, follow the server, one-line wrapper. |
| `tests/unit/category-picker.test.tsx` | Modify | Success mocks send `{ ok: true }`; new cases. |
| `components/TransactionRow.tsx` | Modify | Card payment: pick name as plain text, never a picker. |
| `components/TransactionCard.tsx` | Modify | Same, in the meta line and the sheet. |
| `tests/unit/transaction-row.test.tsx`, `tests/unit/transaction-card.test.tsx` | Modify | Card payment with a pick. |

---

### Task 1: `isCardPaymentRow`

**Files:**
- Modify: `lib/categories.ts:45` (the `CREDIT_CARD_PAYMENT_DETAILED` const) and below `isCreditCardPayment`
- Test: `tests/unit/categories.test.ts`

**Interfaces:**
- Produces: `export const CREDIT_CARD_PAYMENT_DETAILED = 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT'` and `export function isCardPaymentRow(pfcDetailed: string | null): boolean`. Tasks 2 and 4 import both.

- [ ] **Step 1: Write the failing test.** Append to `tests/unit/categories.test.ts` (merge the import into the file's existing `@/lib/categories` import):

```ts
import { isCardPaymentRow, isCreditCardPayment, CREDIT_CARD_PAYMENT_DETAILED } from '@/lib/categories'

// #28 spec §5.2. A card payment is a card payment whatever its label: the route refuses to change
// one, and neither surface offers a picker on one, even when someone filed it by hand before.
// isCreditCardPayment answers a different question ("does it count in the totals?") and returns
// false once a pick is set, which is why the two must not be confused.
describe('isCardPaymentRow', () => {
  it('is true for the card-payment detailed category', () => {
    expect(isCardPaymentRow('LOAN_PAYMENTS_CREDIT_CARD_PAYMENT')).toBe(true)
    expect(CREDIT_CARD_PAYMENT_DETAILED).toBe('LOAN_PAYMENTS_CREDIT_CARD_PAYMENT')
  })

  it('is false for anything else, including null', () => {
    expect(isCardPaymentRow(null)).toBe(false)
    expect(isCardPaymentRow('LOAN_PAYMENTS_MORTGAGE_PAYMENT')).toBe(false)
  })

  it('ignores a pick, unlike isCreditCardPayment', () => {
    const picked = { pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', user_category: 'Shopping' }
    expect(isCardPaymentRow(picked.pfc_detailed)).toBe(true)
    expect(isCreditCardPayment(picked)).toBe(false)
  })
})
```

- [ ] **Step 2: Run it.** `npx vitest run tests/unit/categories.test.ts`. Expected: FAIL, `isCardPaymentRow` is not exported.

- [ ] **Step 3: Implement.** In `lib/categories.ts`, change `const CREDIT_CARD_PAYMENT_DETAILED` to `export const CREDIT_CARD_PAYMENT_DETAILED`, and add directly after `isCreditCardPayment`:

```ts
// True for any credit-card payment, whether or not someone has picked a category for it (#28).
// Not the same question as isCreditCardPayment, which asks whether the row is still KEPT OUT of the
// totals and so turns false once a pick is set. This one asks whether the row may be recategorized:
// never, because any user_category on it re-enters it into every total (#59).
export function isCardPaymentRow(pfcDetailed: string | null): boolean {
  return pfcDetailed === CREDIT_CARD_PAYMENT_DETAILED
}
```

- [ ] **Step 4: Run it.** Same command. Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add lib/categories.ts tests/unit/categories.test.ts
git commit -m "Add isCardPaymentRow, which ignores a pick (#28)"
```

---

### Task 2: The categorize route (spec §6.1 steps 1–7, 9)

**Files:**
- Rewrite: `app/api/transactions/categorize/route.ts`
- Rewrite: `tests/unit/categorize-route.test.ts`

**Interfaces:**
- Consumes: `isCardPaymentRow`, `CREDIT_CARD_PAYMENT_DETAILED` (Task 1).
- Produces: `POST` answers `200 { ok: true }`; `400`/`404`/`409`/`500` with `{ error: string }`, every message written English. The picker (Task 3) shows `error` verbatim.

**Behaviour changes, intentional (spec decision 7 and §6.1 step 4):** the old tests "allows a card payment that the user has already overridden", "clears the override when Uncategorized is chosen", "clears the override when the category is empty" and "treats a whitespace-only category as clearing the override" are replaced by refusals. "Reports an update that matched no rows as 500" becomes 409.

- [ ] **Step 1: Write the failing tests.** Replace `tests/unit/categorize-route.test.ts` entirely:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The only route that sets a category on one transaction (#28 spec §6.1, PR 1). The stand-in is
// strict on purpose, because a permissive one hid three dead guards here before (#99):
// - select() PROJECTS the fixture to the requested columns, so a narrowed read starves the guards;
// - the categories read only resolves through .eq('household_id', …).order('sort_order');
// - update() only resolves after .eq('id') → .eq('removed', false) → .or(<card-payment filter>),
//   so a write missing any guard cannot produce a result at all.
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))

import { createClient } from '@/lib/supabase/server'
import { POST } from '@/app/api/transactions/categorize/route'

type Row = Record<string, unknown>
type Err = { message: string } | null

function project(data: Row | null, columns: string): Row | null {
  if (!data) return data
  const out: Row = {}
  for (const c of columns.split(',').map((s) => s.trim())) if (c in data) out[c] = data[c]
  return out
}

const CARD_FILTER = 'pfc_detailed.is.null,pfc_detailed.neq.LOAN_PAYMENTS_CREDIT_CARD_PAYMENT'

function makeSupabase({
  user = { id: 'user-1' } as { id: string } | null,
  row = null as Row | null,
  readError = null as Err,
  categories = [
    { id: 'c1', name: 'Food & Drink', pfc_primary: 'FOOD_AND_DRINK', sort_order: 1 },
    { id: 'c2', name: 'Grocery', pfc_primary: null, sort_order: 2 },
  ] as Row[] | null,
  categoriesError = null as Err,
  update = { error: null as Err, count: 1 as number | null },
}: Partial<{
  user: { id: string } | null
  row: Row | null
  readError: Err
  categories: Row[] | null
  categoriesError: Err
  update: { error: Err; count: number | null }
}> = {}) {
  const calls = {
    readColumns: '' as string,
    categories: [] as unknown[][],
    updates: [] as { payload: Row; options: unknown; filters: unknown[][] }[],
  }
  const client = {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user } }) },
    from: vi.fn((table: string) => {
      if (table === 'categories') {
        return {
          select: (cols: string) => {
            calls.categories.push(['select', cols])
            return {
              eq: (c: string, v: unknown) => {
                calls.categories.push(['eq', c, v])
                return {
                  order: (c2: string) => {
                    calls.categories.push(['order', c2])
                    return Promise.resolve({ data: categories, error: categoriesError })
                  },
                }
              },
            }
          },
        }
      }
      return {
        select: (cols: string) => {
          calls.readColumns = cols
          return { eq: () => ({ maybeSingle: () => Promise.resolve({ data: project(row, cols), error: readError }) }) }
        },
        update: (payload: Row, options: unknown) => {
          const entry = { payload, options, filters: [] as unknown[][] }
          calls.updates.push(entry)
          return {
            eq: (c1: string, v1: unknown) => {
              entry.filters.push(['eq', c1, v1])
              return {
                eq: (c2: string, v2: unknown) => {
                  entry.filters.push(['eq', c2, v2])
                  return {
                    or: (f: string) => {
                      entry.filters.push(['or', f])
                      return Promise.resolve(update)
                    },
                  }
                },
              }
            },
          }
        },
      }
    }),
  }
  vi.mocked(createClient).mockResolvedValue(client as never)
  return calls
}

const ROW = {
  id: 'txn-1',
  household_id: 'hh-1',
  merchant_name: 'Safeway',
  pfc_primary: 'FOOD_AND_DRINK',
  pfc_detailed: 'FOOD_AND_DRINK_GROCERIES',
  removed: false,
  user_category: null,
}

const post = (body: unknown) =>
  POST(new Request('http://localhost/api/transactions/categorize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }))

let logs: unknown[][]
beforeEach(() => {
  vi.mocked(createClient).mockReset()
  logs = []
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation((...a) => void logs.push(a))
})
afterEach(() => vi.restoreAllMocks())

describe('POST /api/transactions/categorize: validation before the database', () => {
  it.each([
    ['malformed JSON', '{not json'],
    ['no transactionId', { category: 'Grocery' }],
    ['an empty category', { transactionId: 'txn-1', category: '' }],
    ['a whitespace-only category', { transactionId: 'txn-1', category: '   ' }],
  ])('answers 400 for %s without touching the database', async (_, body) => {
    const res = await post(body)
    expect(res.status).toBe(400)
    expect(createClient).not.toHaveBeenCalled()
  })
})

describe('POST /api/transactions/categorize', () => {
  it('answers 401 without a user, with a readable message', async () => {
    makeSupabase({ user: null })
    const res = await post({ transactionId: 'txn-1', category: 'Grocery' })
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe('Your session ended. Sign in again.')
  })

  it('answers 500, not 404, when the read fails, and writes nothing', async () => {
    const calls = makeSupabase({ readError: { message: 'boom' } })
    const res = await post({ transactionId: 'txn-1', category: 'Grocery' })
    expect(res.status).toBe(500)
    expect(calls.updates).toHaveLength(0)
  })

  it('answers 404 when the transaction does not exist', async () => {
    makeSupabase({ row: null })
    expect((await post({ transactionId: 'txn-1', category: 'Grocery' })).status).toBe(404)
  })

  it('reads every column the later steps need', async () => {
    const calls = makeSupabase({ row: ROW })
    await post({ transactionId: 'txn-1', category: 'Grocery' })
    for (const col of ['id', 'household_id', 'merchant_name', 'pfc_primary', 'pfc_detailed', 'removed', 'user_category']) {
      expect(calls.readColumns.split(',').map((c) => c.trim())).toContain(col)
    }
  })

  it('answers 400 for a row the bank removed, and writes nothing', async () => {
    const calls = makeSupabase({ row: { ...ROW, removed: true } })
    const res = await post({ transactionId: 'txn-1', category: 'Grocery' })
    expect(res.status).toBe(400)
    expect(calls.updates).toHaveLength(0)
  })

  // #59: any user_category on a card payment re-enters it into every total.
  it.each([
    ['an unpicked card payment', null],
    ['a card payment someone already filed by hand', 'Shopping'],
  ])('answers 400 for %s, and writes nothing', async (_, pick) => {
    const calls = makeSupabase({
      row: { ...ROW, pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', user_category: pick },
    })
    const res = await post({ transactionId: 'txn-1', category: 'Grocery' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('A credit-card payment is already kept out of spending and income.')
    expect(calls.updates).toHaveLength(0)
  })

  it("reads the row's household's categories, in order", async () => {
    const calls = makeSupabase({ row: ROW })
    await post({ transactionId: 'txn-1', category: 'Grocery' })
    expect(calls.categories).toEqual([
      ['select', 'id, name, pfc_primary, sort_order'],
      ['eq', 'household_id', 'hh-1'],
      ['order', 'sort_order'],
    ])
  })

  it('answers 500 when the categories read fails, and writes nothing', async () => {
    const calls = makeSupabase({ row: ROW, categoriesError: { message: 'boom' } })
    const res = await post({ transactionId: 'txn-1', category: 'Grocery' })
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('That could not be saved. Please try again.')
    expect(calls.updates).toHaveLength(0)
  })

  // Spec decision 7: clearing is not supported; 'Uncategorized' is a display name, not a category.
  it.each(['Uncategorized', 'Not A Category'])('answers 400 for %s, and writes nothing', async (category) => {
    const calls = makeSupabase({ row: ROW })
    const res = await post({ transactionId: 'txn-1', category })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('That category no longer exists. Refresh and try again.')
    expect(calls.updates).toHaveLength(0)
  })

  it('writes the category with every guard inside the update', async () => {
    const calls = makeSupabase({ row: ROW })
    const res = await post({ transactionId: 'txn-1', category: '  Grocery  ' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(calls.updates).toEqual([
      {
        payload: { user_category: 'Grocery' },
        options: { count: 'exact' },
        filters: [['eq', 'id', 'txn-1'], ['eq', 'removed', false], ['or', CARD_FILTER]],
      },
    ])
  })

  it('answers 500 for a failed write, without the database text', async () => {
    makeSupabase({ row: ROW, update: { error: { message: 'new row violates row-level security' }, count: null } })
    const res = await post({ transactionId: 'txn-1', category: 'Grocery' })
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('That could not be saved. Please try again.')
  })

  // The row changed between the read and the write: Plaid removed or re-tagged it.
  it('answers 409 when the write matched no rows', async () => {
    makeSupabase({ row: ROW, update: { error: null, count: 0 } })
    const res = await post({ transactionId: 'txn-1', category: 'Grocery' })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('This transaction just changed. Refresh and try again.')
  })

  // Spec §6.1 step 7: so a mistaken pick can be recovered from the logs.
  it('logs the previous and new category', async () => {
    makeSupabase({ row: { ...ROW, user_category: 'Food & Drink' } })
    await post({ transactionId: 'txn-1', category: 'Grocery' })
    expect(logs).toContainEqual(['[categorize] changed', { id: 'txn-1', from: 'Food & Drink', to: 'Grocery' }])
  })
})
```

- [ ] **Step 2: Run them.** `npx vitest run tests/unit/categorize-route.test.ts`. Expected: most FAIL (malformed JSON throws, the categories read has no `.eq`, the update has no `.or`, 0 rows answers 500, no change log).

- [ ] **Step 3: Implement.** Replace `app/api/transactions/categorize/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isCardPaymentRow, CREDIT_CARD_PAYMENT_DETAILED } from '@/lib/categories'

// Sets the category on ONE transaction (#28 spec §6.1). Runs as the user, so RLS decides WHOSE rows;
// the guards below decide WHICH writes are coherent. Every message here may be shown to a person
// verbatim (CategoryPicker does), so none carries the database's words; those go to the log.
//
// What it will not do:
// - clear a pick, or write 'Uncategorized' (spec decision 7): no UI sends either, and a name that is
//   not a real category would become its own spending bucket;
// - touch a card payment, picked or not (#59): any user_category on one re-enters it into every
//   total. The test is pfc_detailed alone, because isCreditCardPayment turns false once a pick is set;
// - write a row the bank removed.
const SAVE_FAILED = 'That could not be saved. Please try again.'

export async function POST(req: Request) {
  // 1. Validate before touching the database.
  const body = (await req.json().catch(() => null)) as { transactionId?: unknown; category?: unknown } | null
  const transactionId = typeof body?.transactionId === 'string' ? body.transactionId : ''
  const category = typeof body?.category === 'string' ? body.category.trim() : ''
  if (!transactionId || !category) {
    return NextResponse.json({ error: 'Choose a category for this transaction.' }, { status: 400 })
  }

  // 2. Sign-in. proxy.ts usually redirects a signed-out /api call first; this stays as defence.
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Your session ended. Sign in again.' }, { status: 401 })

  // 3. Read the row. Every column here is used below, or by learning in PR 3.
  const { data: row, error: readError } = await supabase
    .from('transactions')
    .select('id, household_id, merchant_name, pfc_primary, pfc_detailed, removed, user_category')
    .eq('id', transactionId)
    .maybeSingle()
  // Fail closed: a read error must not pass for "no such transaction" or fall through to the write.
  if (readError) {
    console.error('[categorize] transaction read failed', readError.message)
    return NextResponse.json({ error: SAVE_FAILED }, { status: 500 })
  }
  if (!row) {
    return NextResponse.json({ error: 'That transaction no longer exists. Refresh and try again.' }, { status: 404 })
  }
  if (row.removed) {
    return NextResponse.json(
      { error: 'Your bank removed that transaction. Refresh and try again.' },
      { status: 400 }
    )
  }

  // 4. Card payments, picked or not.
  if (isCardPaymentRow(row.pfc_detailed)) {
    return NextResponse.json(
      { error: 'A credit-card payment is already kept out of spending and income.' },
      { status: 400 }
    )
  }

  // 5. The row's household's categories, whole and in order: PR 3 builds its kind gate from this
  //    list, which must never be partial.
  const { data: cats, error: catsError } = await supabase
    .from('categories')
    .select('id, name, pfc_primary, sort_order')
    .eq('household_id', row.household_id)
    .order('sort_order')
  if (catsError) {
    console.error('[categorize] categories read failed', catsError.message)
    return NextResponse.json({ error: SAVE_FAILED }, { status: 500 })
  }
  const picked = (cats ?? []).find((c) => c.name === category)
  if (!picked) {
    return NextResponse.json(
      { error: 'That category no longer exists. Refresh and try again.' },
      { status: 400 }
    )
  }

  // 6. Write, with the guards INSIDE the update, so Plaid re-tagging or removing the row between the
  //    read and the write cannot slip through. The .or is deliberate: .neq alone would silently skip
  //    rows whose pfc_detailed is null. `count` is what tells "wrote it" from "matched nothing" (#73).
  const { error, count } = await supabase
    .from('transactions')
    .update({ user_category: picked.name }, { count: 'exact' })
    .eq('id', transactionId)
    .eq('removed', false)
    .or(`pfc_detailed.is.null,pfc_detailed.neq.${CREDIT_CARD_PAYMENT_DETAILED}`)
  if (error) {
    console.error('[categorize] update failed', error.message)
    return NextResponse.json({ error: SAVE_FAILED }, { status: 500 })
  }
  if (!count) {
    // Usually the row changed underneath us. A missing update policy would also land here, which is
    // why the log says both.
    console.error('[categorize] update matched no rows (row changed, or the update policy is missing)', transactionId)
    return NextResponse.json({ error: 'This transaction just changed. Refresh and try again.' }, { status: 409 })
  }

  // 7. A record of every change, so a mistaken pick can be put back from the logs.
  console.info('[categorize] changed', { id: transactionId, from: row.user_category, to: picked.name })

  // 9. PR 3 adds `learned` here.
  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 4: Run them.** Same command. Expected: PASS (19 tests).

- [ ] **Step 5: Mutation-check each guard.** For each of these edits: apply it, run the file, confirm at least one test FAILS, then restore with `git checkout app/api/transactions/categorize/route.ts`:
  - delete `if (row.removed) { … }`;
  - change `isCardPaymentRow(row.pfc_detailed)` to `isCreditCardPayment(row)` (import it);
  - delete `.eq('removed', false)` from the update;
  - delete the `.or(…)` line;
  - change `if (!count)` to `if (count === null)`;
  - delete the `console.info` line;
  - change `.eq('household_id', row.household_id)` to `.eq('household_id', user.id)`.

- [ ] **Step 6: Commit.**

```bash
git add app/api/transactions/categorize/route.ts tests/unit/categorize-route.test.ts
git commit -m "Harden the categorize route: refuse every card payment and removed rows, guard inside the write, 409 on a changed row (#28)"
```

---

### Task 3: `CategoryPicker` (spec §8.2, keyed on `value`)

**Files:**
- Modify: `components/CategoryPicker.tsx`
- Modify: `tests/unit/category-picker.test.tsx`

**Interfaces:**
- Consumes: Task 2's response contract.
- Produces: unchanged props (`transactionId`, `value`, `options`, `label?`, `onBusyChange?`). It renders one wrapper `<span>` (was a fragment) holding the select and, on failure, a `role="alert"`.

**Adaptation from the spec, flagged:** the spec's wrapper is `inline-flex … flex-nowrap` at every width, but the spec predates the phone pass. In the phone sheet (`TransactionCard.tsx`) the picker is full width in a column. So the wrapper is a full-width column below `md` (alert under the select) and a one-line `inline-flex` from `md` up, where #50's one-line rule applies.

- [ ] **Step 1: Update the success mocks.** In `tests/unit/category-picker.test.tsx`, every `fetch` stub that stands for a successful save currently resolves `{ ok: true, json: async () => ({}) }`. Change each to `{ ok: true, redirected: false, json: async () => ({ ok: true }) }`. Failure stubs gain `redirected: false`.

- [ ] **Step 2: Write the failing tests.** Append inside the `describe('CategoryPicker', …)` block:

```tsx
  // A signed-out /api call is redirected to /login by proxy.ts, and fetch follows it to a 200 HTML
  // page. That is not a save.
  it('treats a redirected response as a failure, and does not refresh', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, redirected: true, json: async () => ({ ok: true }) }))
    render(<CategoryPicker {...props} />)
    fireEvent.change(select(), { target: { value: 'Shopping' } })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Your session ended. Sign in again.'))
    expect(select().value).toBe('Food & Drink')
    expect(refresh).not.toHaveBeenCalled()
  })

  it('treats a response that is not JSON as a failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, redirected: false, json: async () => { throw new SyntaxError('html') } }))
    render(<CategoryPicker {...props} />)
    fireEvent.change(select(), { target: { value: 'Shopping' } })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Your session ended. Sign in again.'))
    expect(select().value).toBe('Food & Drink')
  })

  it('needs ok: true in the body, not just a 200', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, redirected: false, json: async () => ({}) }))
    render(<CategoryPicker {...props} />)
    fireEvent.change(select(), { target: { value: 'Shopping' } })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('That could not be saved.'))
    expect(refresh).not.toHaveBeenCalled()
  })

  // Another household member, or a later PR's rule, changes the row; the refreshed page brings the
  // new value. The picker must show it, not the value it was mounted with (#102).
  it('follows the server when its value changes', () => {
    const { rerender } = render(<CategoryPicker {...props} />)
    rerender(<CategoryPicker {...props} value="Travel" />)
    expect(select().value).toBe('Travel')
  })

  it('clears its alert when the server value changes', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, redirected: false, json: async () => ({ error: 'No.' }) }))
    const { rerender } = render(<CategoryPicker {...props} />)
    fireEvent.change(select(), { target: { value: 'Shopping' } })
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    rerender(<CategoryPicker {...props} value="Travel" />)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  // #50: on the desktop row an error must not add a line. On a phone the sheet has room, and the
  // picker must stay full width.
  it('keeps select and alert in one wrapper: a column on phones, one line from md', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, redirected: false, json: async () => ({ error: 'No.' }) }))
    render(<CategoryPicker {...props} />)
    fireEvent.change(select(), { target: { value: 'Shopping' } })
    const alert = await screen.findByRole('alert')
    const wrapper = select().parentElement!
    expect(alert.parentElement).toBe(wrapper)
    for (const c of ['flex', 'w-full', 'flex-col', 'md:inline-flex', 'md:w-auto', 'md:flex-row', 'md:flex-nowrap']) {
      expect(wrapper.className.split(/\s+/)).toContain(c)
    }
    expect(alert.className).toContain('md:truncate')
  })
```

- [ ] **Step 3: Run them.** `npx vitest run tests/unit/category-picker.test.tsx`. Expected: the six new tests FAIL; the existing ones pass with the updated mocks.

- [ ] **Step 4: Implement.** Replace `components/CategoryPicker.tsx`:

```tsx
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { selectClass } from './ui/styles'

const SAVE_FAILED = 'That could not be saved.'
const SESSION_ENDED = 'Your session ended. Sign in again.'

export function CategoryPicker({
  transactionId,
  value,
  options,
  label,
  onBusyChange,
}: {
  transactionId: string
  value: string
  options: string[]
  label?: string
  // Told whenever a save starts and stops, so a host that can UNMOUNT this control (the phone sheet)
  // can refuse to close over a request in flight; a failed save's message would otherwise land on an
  // unmounted component and be lost. The desktop row passes nothing.
  onBusyChange?: (busy: boolean) => void
}) {
  const router = useRouter()
  const [val, setVal] = useState(value)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Follow the server. When a refresh brings a new value (another household member, or a rule from
  // PR 2), show it and drop any stale optimistic value or alert. React's documented way to adjust
  // state when a prop changes; the same idiom as ReimbursableCheckbox.
  const [seen, setSeen] = useState(value)
  if (seen !== value) {
    setSeen(value)
    setVal(value)
    setError(null)
  }

  // The current value is always selectable, even when it is 'Uncategorized' or a stale name.
  const opts = options.includes(val) ? options : [val, ...options]

  function working(now: boolean) {
    setSaving(now)
    onBusyChange?.(now)
  }

  async function change(e: React.ChangeEvent<HTMLSelectElement>) {
    const category = e.target.value
    setVal(category)
    working(true)
    setError(null)
    let saved = false
    try {
      const res = await fetch('/api/transactions/categorize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transactionId, category }),
      })
      const body = (await res.json().catch(() => null)) as { ok?: unknown; error?: unknown } | null
      // A signed-out call is redirected to /login and fetch follows it to an HTML page: a 200 that
      // saved nothing. Only the route's own JSON `ok: true` is a save.
      if (res.redirected || body === null) {
        setVal(value)
        setError(SESSION_ENDED)
        return
      }
      if (!res.ok || body.ok !== true) {
        // Back to what the server has (the prop), not to the last local value (#102).
        setVal(value)
        setError(typeof body.error === 'string' ? body.error : SAVE_FAILED)
        return
      }
      saved = true
    } catch {
      setVal(value)
      setError(SAVE_FAILED)
    } finally {
      // `disabled` means "in flight", never "has failed".
      working(false)
    }
    // Outside the try: a throw from refresh is not a failed save.
    if (saved) router.refresh()
  }

  // One wrapper for the select and its alert. Below md it is a full-width column, because the phone
  // sheet (TransactionCard.tsx) gives the picker the full width and has room for an alert beneath.
  // From md up it is one line, alert truncated beside the select, so an error never adds a line to a
  // desktop row (#50). The select's own `w-full md:w-auto` (selectClass) still sets its width.
  return (
    <span className="flex w-full min-w-0 flex-col gap-1 md:inline-flex md:w-auto md:flex-row md:flex-nowrap md:items-center md:gap-1.5">
      <select
        value={val}
        onChange={change}
        disabled={saving}
        aria-label={label ? `Category for ${label}` : 'Transaction category'}
        className={selectClass}
      >
        {opts.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
      {error && (
        <span role="alert" className="text-xs text-coral md:min-w-0 md:truncate">
          {error}
        </span>
      )}
    </span>
  )
}
```

- [ ] **Step 5: Run them.** Same command. Expected: PASS. Then `npx vitest run tests/unit/transaction-card.test.tsx tests/unit/transaction-row.test.tsx`. Expected: PASS (they render the picker).

- [ ] **Step 6: Mutation-check.** Each must fail at least one test, then restore with `git checkout components/CategoryPicker.tsx`:
  - delete `res.redirected ||`;
  - change `body.ok !== true` to `false`;
  - delete the `if (seen !== value) { … }` block;
  - change `setVal(value)` in the `!res.ok` branch to `setVal(category)`;
  - remove `md:flex-nowrap` from the wrapper.

- [ ] **Step 7: Commit.**

```bash
git add components/CategoryPicker.tsx tests/unit/category-picker.test.tsx
git commit -m "Make CategoryPicker's save honest and follow the server's value (#28, #102)"
```

---

### Task 4: Card payments show their pick as text (spec §8.1, PR 1 part)

**Files:**
- Modify: `components/TransactionRow.tsx:44-63` (the Category cell)
- Modify: `components/TransactionCard.tsx:66` (`categoryLabel`) and `:143-146` (the sheet branch)
- Modify: `tests/unit/transaction-row.test.tsx`, `tests/unit/transaction-card.test.tsx`

**Interfaces:**
- Consumes: `isCardPaymentRow` (Task 1).
- Produces: nothing new; props unchanged. `isCC` keeps driving amount styling, the reimbursable controls and the sheet's busy gate.

- [ ] **Step 1: Write the failing tests.** Append to `tests/unit/transaction-row.test.tsx`:

```tsx
// Spec §8.1. The route now refuses every card payment, including one someone filed by hand before
// (Task 2), so the row must not offer a picker that always fails. It shows the pick as plain text.
describe('TransactionRow card payment with a pick', () => {
  it('shows the pick as text, with no picker', () => {
    renderRow({ pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', user_category: 'Shopping' })
    expect(screen.getByText('Shopping')).toBeTruthy()
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('still says Card payment when there is no pick', () => {
    renderRow({ pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' })
    expect(screen.getByText('Card payment')).toBeTruthy()
    expect(screen.queryByRole('combobox')).toBeNull()
  })
})
```

Append to `tests/unit/transaction-card.test.tsx` (it already imports `fireEvent` and `within`; add them to the Testing Library import if not):

```tsx
describe('TransactionCard card payment with a pick', () => {
  const picked = { pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', user_category: 'Shopping' }

  it('names the pick on the row', () => {
    renderCard(picked)
    expect(screen.getByText(/2026-08-29 · Shopping/)).toBeTruthy()
  })

  it('offers no picker in the sheet', () => {
    renderCard(picked)
    fireEvent.click(screen.getByRole('button', { name: /Joe S Den/ }))
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.getByText(/Shopping · card payment, moves between your accounts\./)).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run them.** `npx vitest run tests/unit/transaction-row.test.tsx tests/unit/transaction-card.test.tsx`. Expected: the "with a pick" tests FAIL (both surfaces currently show a picker, because `isCC` is false once a pick is set).

- [ ] **Step 3: Implement `TransactionRow`.** Add `import { isCardPaymentRow } from '@/lib/categories'`. After `const marked = …`, add:

```tsx
  // Not isCC: that turns false once someone has picked a category, and the route refuses to change
  // ANY card payment (#28). A card payment shows its pick as text, never a picker that always fails.
  const cardPayment = isCardPaymentRow(t.pfc_detailed)
```

Replace the cell's content `{isCC ? (<span …>Card payment</span>) : (<CategoryPicker … />)}` with:

```tsx
        {cardPayment ? (
          <span className="text-sm text-muted">{t.user_category ?? 'Card payment'}</span>
        ) : (
          <CategoryPicker
            transactionId={t.id}
            value={categoryName}
            options={categoryOptions}
            label={label}
          />
        )}
```

In the comment above the cell, add one sentence at the end: "A card payment someone filed by hand before #28 shows that pick as text: the route refuses to change any card payment."

- [ ] **Step 4: Implement `TransactionCard`.** Add the same import and, after the `presentTransaction` line:

```tsx
  // As TransactionRow: the route refuses every card payment, picked or not (#28).
  const cardPayment = isCardPaymentRow(t.pfc_detailed)
```

Change `const categoryLabel = isCC ? 'Card payment' : categoryName` to:

```tsx
  const categoryLabel = cardPayment ? (t.user_category ?? 'Card payment') : categoryName
```

Change the sheet branch condition from `{isCC ? (` to `{cardPayment ? (`, and its paragraph to:

```tsx
              <p className="mt-4 text-sm text-muted">
                {t.user_category
                  ? `${t.user_category} · card payment, moves between your accounts.`
                  : 'Card payment — moves between your accounts.'}
              </p>
```

Leave `busy`'s `!isCC` gate as is: an unpicked card payment is still the case it guards. A picked card payment now also has no controls, so its busy flags are never set.

- [ ] **Step 5: Run them.** Same command. Expected: PASS, including the existing card-payment tests ("Card payment" on unpicked rows, the screen-reader name).

- [ ] **Step 6: Mutation-check.** Each must fail at least one test, then restore with `git checkout components/`:
  - in `TransactionRow`, use `isCC` instead of `cardPayment` in the cell;
  - in `TransactionCard`, use `isCC` instead of `cardPayment` in the sheet branch;
  - in `TransactionCard`, drop `t.user_category ??` from `categoryLabel`.

- [ ] **Step 7: Commit.**

```bash
git add components/TransactionRow.tsx components/TransactionCard.tsx tests/unit/transaction-row.test.tsx tests/unit/transaction-card.test.tsx
git commit -m "Show a card payment's pick as text on both surfaces, never a picker (#28)"
```

---

### Task 5: Verify and open PR 1

**Files:** none new.

- [ ] **Step 1: Full checks.**

```bash
npx tsc --noEmit
npm run -s lint
npx vitest run
VITEST_TZ=America/Los_Angeles npx vitest run
npm run -s check:invariants
npm run -s check:secrets
npm run -s build
```

Expected: all clean. If `next dev` was run, restore `AGENTS.md` with `git checkout AGENTS.md` before committing.

- [ ] **Step 2: Back up hand picks** (spec §10.2 step 1, read-only). With the service-role key from `.env.local`, export `id, plaid_transaction_id, merchant_name, date, amount, user_category` for rows where `user_category is not null` to a CSV outside the repo. Then run the card-payment check and expect 0 rows:

```sql
select id, merchant_name, date, user_category, reimbursable_amount from public.transactions
where removed = false and pfc_detailed = 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT'
  and (user_category is not null or reimbursable_amount is not null);
```

- [ ] **Step 3: Open the PR** from a branch off `main` named `feat/28-pr1-honest-save` (the spec branch `28-category-rules` holds only docs). Body: what changed per task, the two intentional behaviour changes (picked card payments refused; clearing refused), the mutation checks, and what the owner checks on the phone after deploy:
  - pick a category on an ordinary transaction, on desktop and in the phone sheet;
  - a transaction that fails to save shows the reason and snaps back;
  - card payments show no picker.

---

## Self-review notes

- **Spec coverage (PR 1 of §10.1):**
  - §5.2's exports: Task 1.
  - §6.1 steps 1–7 and 9: Task 2.
  - §8.2 keyed on `value` with its one-line wrapper: Task 3, adapted for the phone sheet as flagged there.
  - The §8.1 card-payment cell on `categoryName`: Task 4, extended to `TransactionCard`, which the spec predates.
  - §11's PR 1 test list: covered by Tasks 1–4. "`transaction-row.test.tsx`'s card-payment-with-a-pick case" is in Task 4.
- **Out of PR 1, on purpose:** learning (§6.1 step 8, PR 3), `source`-keyed re-sync (PR 2), the learned marker (PR 2).
- **Closes or advances:** #102 item 1 (stale picker value), #103 item 1 (developer tokens shown: the route's messages are now written English). #102 item 2 (clearing an override) is declined by spec decision 7; say so on the issue when PR 1 merges.
