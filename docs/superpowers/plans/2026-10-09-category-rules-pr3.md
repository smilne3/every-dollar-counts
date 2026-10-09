# Category Learning, PR 3: Learn a Rule From a First Pick — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When someone picks a category for a merchant that has no rule, the app silently creates a household rule for that merchant, so its other transactions, past and future, are filed the same way. A failed learn never fails the pick.

**Architecture:** One new pure function, `learnableRule(row, pickedName, k)` in `lib/category-rules.ts`, decides whether a pick teaches. It applies exactly the gate `resolveCategory` uses to apply a rule, so a learned rule always relabels the row it was learned from. `POST /api/transactions/categorize` calls it after the pick is saved (spec §6.1 step 8). If it teaches, the route checks the environment and then inserts the rule with `INSERT … ON CONFLICT DO NOTHING RETURNING id`. The response gains `learned: 'created' | 'exists' | 'no' | 'skipped' | 'failed'`. The UI shows nothing new (decision 1). PR 2 removed the learning copy from Settings → Category rules; this PR puts it back. Nothing else changes: rules are still resolved only at read time, and PR 2's pages already show a new rule on the next `router.refresh()`.

**Tech Stack:** Next.js 16 App Router route handler, Supabase (`@supabase/ssr` server client, RLS; postgrest-js `upsert` with `ignoreDuplicates`), React 19 client component, Vitest + Testing Library (jsdom). No new dependencies, and no migration: `category_rules` (021) is live with 22 rules.

**Spec:** `docs/superpowers/specs/2026-09-11-category-rules-design.md` (on `main` since #146). This plan implements PR 3 of §10.1: §6.1 step 8, step 9's `learned` field, the PR 3 test list in §11, and the §10.2 step 5 production check. It also restores the §8.3 copy that PR 2 held back. Read §2 decisions 1, 3, 4 and 6, and §2.1's first bullet, before Task 1.

## Global Constraints

- **Learning never writes `user_category`** and never touches `transactions` (decision 2). The only new write is one `category_rules` insert.
- **A failed learn never fails the pick.** Once step 6's update has succeeded, the route answers `200 { ok: true, learned }` whatever happens in step 8, including a thrown error.
- **Learn only when** all hold (spec §6.1 step 8, decision 4, §2.1):
  - `merchantKey(row.merchant_name)` is not null;
  - the row is not a card payment (`isCardPaymentRow(pfc_detailed)`, never `isCreditCardPayment`);
  - `kindOf(picked) === bankCategory(row).kind` **and** `kindOf(picked) === kindOf(bankCategory(row).name)`;
  - `picked !== bankCategory(row).name`.
- **The kind gate is built from the whole category list** the route already read in step 5 (`buildKindContext(cats)`). Never from a partial list.
- **Environment-guarded.** `assertEnvMatchesDatabase()` runs before the insert. `EnvMismatchError` → `'skipped'`, logged `[categorize] learn skipped: environment`; any other error → `'failed'`, logged `[categorize] learn failed`. Local and Preview never create rules.
- **First pick only.** The insert is `upsert(…, { onConflict: 'household_id,merchant_key', ignoreDuplicates: true }).select('id')`. A row back means `created`; none means `exists`, and the pick stays a one-row exception (decision 3). It never updates an existing rule.
- **The insert payload is exactly** `{ household_id: row.household_id, merchant_key, merchant_label, category_id: picked.id, origin: 'learned' }`, with `merchant_label` the row's `merchant_name` trimmed.
- **The database's words are logged, never returned.** `learned` is a fixed word; no message is added to the response.
- **Copy is exact.** UI strings below are copied verbatim from spec §8.3.
- **Run before the PR:** `npx vitest run`, `VITEST_TZ=America/Los_Angeles npx vitest run`, `npx tsc --noEmit`, `npm run lint`, `npm run check:invariants`, `npm run check:secrets`, `npx next build`.
- **Every guard added gets a mutation check** before the PR: revert it, watch a named test fail, then restore it. Task 4 lists them.
- **Out-of-scope findings become GitHub issues** (`.claude/rules/filing-issues.md`), never fixes on this branch.

## Review Focus

The five inputs most likely to bite the household that the spec's PR 3 test list doesn't pin. Each one's test is added to the task that owns it.

1. **A re-pick on a row that already carries a pick, for a merchant with no rule.** Every pick made between PR 2 and PR 3 is like this. Spec §10.2: "the merchant's next pick after PR 3 does" teach. It must learn; the earlier `user_category` must not block it. *(Task 2: "learns from a re-pick on an already-picked row".)*
2. **Merchant spelling.** `' SAFEWAY '` must learn the key `safeway` with the label `SAFEWAY`, never `' SAFEWAY '`, so it matches PR 2's resolver and the seed. *(Task 1: "trims the label and lowercases the key"; Task 2: exact payload for a padded name.)*
3. **A learned rule that does nothing.** Any pick the gate admits must relabel its own row once the pick is gone. If the gate and the resolver drift apart, Settings lists a rule with "No current transactions" or 0 changed, or the gate refuses a rule the resolver would apply. *(Task 1: the agreement property over every row × category × deleted-default combination.)*
4. **The insert throwing instead of returning an error** (a network reset inside postgrest-js, or a mocked rejection). The pick has been saved, so the person must see success. A 500 here would roll back a select whose value the server kept. *(Task 2: "a thrown insert still answers 200 failed".)*
5. **A pick on an unmapped spending row** (`pfc_primary` with no household category, such as `LOAN_DISBURSEMENTS`). The row shows `Uncategorized`, and both kinds are spending. Picking Grocery teaches, and the rule then relabels that row. *(Task 1: covered by the agreement property, plus a named case.)*

---

## File Structure

| File | Change | Responsibility |
| --- | --- | --- |
| `lib/category-rules.ts` | Modify | Add `learnableRule` and `LearnableRule`. Pure. |
| `tests/unit/category-rules.test.ts` | Modify | `learnableRule` cases and the agreement property. |
| `app/api/transactions/categorize/route.ts` | Modify | Step 8 (`learn`), and step 9's `learned` field. |
| `tests/unit/categorize-route.test.ts` | Modify | Stand-in gains `category_rules` and the environment guard; the PR 3 cases. |
| `scripts/check-invariants.mjs` | Modify | Reason strings only: the categorize route now learns (no rule change). |
| `components/CategoryRulesCard.tsx` | Modify | Restore the help text, the empty state and Remove's "teach again" line. |
| `tests/unit/category-rules-card.test.tsx` | Modify | Assert the restored copy. |
| `docs/superpowers/specs/2026-09-11-category-rules-design.md` | Modify | Status line only. |

---

### Task 1: `learnableRule`, the gate for teaching

**Files:**
- Modify: `lib/category-rules.ts` (after `changedByRule`, end of file)
- Test: `tests/unit/category-rules.test.ts` (new `describe` at the end)

**Interfaces:**
- Consumes: `merchantKey`, `kindOf`, the private `bankCategory`, `buildKindContext`, `KindContext` (all in `lib/category-rules.ts`); `isCardPaymentRow` from `lib/categories.ts`.
- Produces:
  ```ts
  export type LearnableRule = { merchantKey: string; merchantLabel: string }
  export function learnableRule(
    row: { merchant_name: string | null; pfc_primary: string | null; pfc_detailed: string | null },
    pickedName: string,
    k: KindContext
  ): LearnableRule | null
  ```
  Task 2 calls it with the route's row and `buildKindContext(cats)`.

**Why a function in the pure lib, not inline in the route:** `bankCategory` is private to `lib/category-rules.ts`, and the gate must stay identical to `resolveCategory`'s. Keeping both in one file, with one test proving they agree, is the guard against drift.

- [ ] **Step 1: Write the failing tests**

Add `learnableRule` to the existing import from `@/lib/category-rules` at the top of `tests/unit/category-rules.test.ts`. Then append:

```ts
// #28 spec §6.1 step 8: whether a pick teaches. The gate is resolveCategory's own (§5.3 step 4), so
// a learned rule always relabels the row it was learned from (decision 4, §2.1).
describe('learnableRule', () => {
  const k = buildKindContext(DEFAULTS)
  // learnableRule never looks at user_category: a re-pick teaches like a first pick (Task 2).
  const txn = row

  it('teaches a same-kind pick that differs from the bank', () => {
    expect(learnableRule(txn(), 'Grocery', k)).toEqual({ merchantKey: 'safeway', merchantLabel: 'Safeway' })
  })

  it('trims the label and lowercases the key', () => {
    expect(learnableRule(txn({ merchant_name: '  SAFEWAY ' }), 'Grocery', k)).toEqual({
      merchantKey: 'safeway',
      merchantLabel: 'SAFEWAY',
    })
  })

  it.each([null, '', '   '])('teaches nothing without a merchant name (%j)', (merchant_name) => {
    expect(learnableRule(txn({ merchant_name }), 'Grocery', k)).toBeNull()
  })

  it('teaches nothing when the pick equals the bank category', () => {
    expect(learnableRule(txn(), 'Food & Drink', k)).toBeNull()
  })

  it('teaches nothing across the line', () => {
    expect(learnableRule(txn(), 'Income', k)).toBeNull()
    expect(learnableRule(txn(), 'Transfer Out', k)).toBeNull()
    expect(learnableRule(txn({ pfc_primary: 'TRANSFER_OUT' }), 'Grocery', k)).toBeNull()
  })

  it('teaches nothing on a card payment, even with a merchant name', () => {
    expect(
      learnableRule(txn({ pfc_primary: 'LOAN_PAYMENTS', pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' }), 'Grocery', k)
    ).toBeNull()
  })

  it('teaches nothing on a TRANSFER_OUT row after "Transfer Out" is deleted', () => {
    const k2 = buildKindContext(without('Transfer Out'))
    // Plaid's kind is transfer; the row shows Uncategorized, which counts as spending.
    expect(learnableRule(txn({ pfc_primary: 'TRANSFER_OUT' }), 'Grocery', k2)).toBeNull()
    expect(learnableRule(txn({ pfc_primary: 'TRANSFER_OUT' }), 'Transfer In', k2)).toBeNull()
  })

  it('teaches nothing on an INCOME row after "Income" is deleted', () => {
    expect(learnableRule(txn({ pfc_primary: 'INCOME' }), 'Grocery', buildKindContext(without('Income')))).toBeNull()
  })

  it('teaches a spending pick on an unmapped spending row', () => {
    expect(learnableRule(txn({ pfc_primary: 'LOAN_DISBURSEMENTS' }), 'Grocery', k)).toEqual({
      merchantKey: 'safeway',
      merchantLabel: 'Safeway',
    })
  })

  it('teaches a same-kind pick within transfers', () => {
    expect(learnableRule(txn({ pfc_primary: 'TRANSFER_OUT' }), 'Transfer In', k)).not.toBeNull()
  })

  // The property that keeps the gate and the resolver from drifting apart: a pick teaches exactly
  // when the rule it would create relabels that same row once the pick is gone.
  it('agrees with resolveCategory on every row, pick and category set', () => {
    const sets = [DEFAULTS, without('Income'), without('Transfer In'), without('Transfer Out'),
      [...DEFAULTS, cat('Uncategorized', null, 200)]]
    const primaries = ['FOOD_AND_DRINK', 'INCOME', 'TRANSFER_IN', 'TRANSFER_OUT', 'LOAN_PAYMENTS',
      'LOAN_DISBURSEMENTS', null]
    const details = [null, 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT']
    let taught = 0
    for (const cats of sets) {
      const kc = buildKindContext(cats)
      for (const pfc_primary of primaries) for (const pfc_detailed of details) for (const picked of cats) {
        const t = txn({ pfc_primary, pfc_detailed })
        const learned = learnableRule(t, picked.name, kc)
        const resolved = resolveCategory({ ...t, user_category: null },
          testCtx(cats, [rule('Safeway', picked.id)]))
        expect({ pfc_primary, pfc_detailed, picked: picked.name, learned: learned !== null })
          .toEqual({ pfc_primary, pfc_detailed, picked: picked.name, learned: changedByRule(resolved) })
        if (learned) taught++
      }
    }
    expect(taught).toBeGreaterThan(0) // the property must not hold vacuously
  })
})
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run tests/unit/category-rules.test.ts`
Expected: FAIL. `learnableRule` is not exported (`learnableRule is not a function`).

- [ ] **Step 3: Implement**

Append to `lib/category-rules.ts`:

```ts
export type LearnableRule = { merchantKey: string; merchantLabel: string }

// Whether a hand pick teaches a merchant rule (spec §6.1 step 8), and if so its key and display
// spelling. The gate is resolveCategory's step 3 exactly, plus "the pick isn't the bank's own
// category", so a learned rule always relabels the row it was learned from: a pick that agrees with
// the bank would pin the merchant to a rule that changes nothing (§2.1). `k` must be built from the
// household's WHOLE category list.
export function learnableRule(
  row: { merchant_name: string | null; pfc_primary: string | null; pfc_detailed: string | null },
  pickedName: string,
  k: KindContext
): LearnableRule | null {
  const key = merchantKey(row.merchant_name)
  if (!key || isCardPaymentRow(row.pfc_detailed)) return null
  const bank = bankCategory(row, k)
  const kind = kindOf(pickedName, k)
  if (kind !== bank.kind || kind !== kindOf(bank.name, k) || pickedName === bank.name) return null
  return { merchantKey: key, merchantLabel: (row.merchant_name ?? '').trim() }
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run tests/unit/category-rules.test.ts`
Expected: PASS, including the agreement property.

- [ ] **Step 5: Commit**

```bash
git add lib/category-rules.ts tests/unit/category-rules.test.ts
git commit -m "Category learning, PR 3: learnableRule, the gate for teaching (#28)"
```

---

### Task 2: The categorize route learns (spec §6.1 steps 8 and 9)

**Files:**
- Modify: `app/api/transactions/categorize/route.ts` (imports; header comment; step 3's comment; replace lines 125-126)
- Modify: `scripts/check-invariants.mjs` (two reason strings in `CATEGORY_READS_ALLOWED` and `RULES_READS_ALLOWED`)
- Test: `tests/unit/categorize-route.test.ts`

**Interfaces:**
- Consumes: `learnableRule`, `buildKindContext` (Task 1 / `lib/category-rules.ts`); `assertEnvMatchesDatabase`, `EnvMismatchError` (`lib/app-env.ts`); `type Category` (`lib/categories.ts`).
- Produces: the response `200 { ok: true, learned: 'created' | 'exists' | 'no' | 'skipped' | 'failed' }`. `CategoryPicker` reads only `ok`, so the UI does not change.

- [ ] **Step 1: Extend the test stand-in**

In `tests/unit/categorize-route.test.ts`:

1. Directly under the existing `vi.mock('@/lib/supabase/server', …)` line, add the environment-guard mocks, following `tests/unit/category-rules-route.test.ts:46-51`:

```ts
const { assertEnvMatchesDatabase } = vi.hoisted(() => ({ assertEnvMatchesDatabase: vi.fn() }))
vi.mock('@/lib/plaid', () => ({ plaidEnv: 'production' }))
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: {} }))
vi.mock('@/lib/app-env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/app-env')>()),
  assertEnvMatchesDatabase,
}))
```

and add `import { EnvMismatchError } from '@/lib/app-env'` beside the other imports.

2. Give `makeSupabase` an `upsert` option and record the call. Add the option to the destructured parameters and to the `Partial<…>` type:

```ts
  upsert = { data: [{ id: 'r-new' }] as Row[] | null, error: null as ({ code?: string; message: string } | null) },
```
```ts
  upsert: { data: Row[] | null; error: { code?: string; message: string } | null } | 'throw'
```

Add `upserts: [] as { payload: Row; options: unknown; select: string }[]` to `calls`. At the top of `from`, before the `categories` branch, add:

```ts
      if (table === 'category_rules') {
        return {
          upsert: (payload: Row, options: unknown) => ({
            select: (cols: string) => {
              calls.upserts.push({ payload, options, select: cols })
              return upsert === 'throw' ? Promise.reject(new Error('socket hang up')) : Promise.resolve(upsert)
            },
          }),
        }
      }
```

3. In `beforeEach`, reset the guard and capture warnings:

```ts
  assertEnvMatchesDatabase.mockReset().mockResolvedValue(undefined)
  vi.spyOn(console, 'warn').mockImplementation((...a) => void logs.push(a))
```

and make the existing `console.error` spy record too, so the failure tags can be asserted:

```ts
  vi.spyOn(console, 'error').mockImplementation((...a) => void logs.push(a))
```

4. The existing test at line 262 asserts `toEqual({ ok: true })`. With a Safeway row picked as Grocery it now learns, so change it to `toEqual({ ok: true, learned: 'created' })`. No other existing assertion changes meaning. Check that the "logs no change" tests still pass: they look only for `'[categorize] changed'`.

- [ ] **Step 2: Write the failing tests**

Append to `tests/unit/categorize-route.test.ts`:

```ts
// #28 spec §6.1 step 8 (PR 3). A first pick for a merchant teaches a household rule; a failed learn
// never fails the pick, which is already saved.
describe('POST /api/transactions/categorize: learning', () => {
  const pick = (category = 'Grocery') => post({ transactionId: 'txn-1', category })

  it('creates the rule with the exact payload and options', async () => {
    const calls = makeSupabase({ row: ROW })
    const res = await pick()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, learned: 'created' })
    expect(calls.upserts).toEqual([{
      payload: { household_id: 'hh-1', merchant_key: 'safeway', merchant_label: 'Safeway', category_id: 'c2', origin: 'learned' },
      options: { onConflict: 'household_id,merchant_key', ignoreDuplicates: true },
      select: 'id',
    }])
    expect(logs).toContainEqual(['[categorize] learned', { merchant_key: 'safeway', category: 'Grocery', rule: 'r-new' }])
  })

  it('learns from a padded merchant name with a trimmed label', async () => {
    const calls = makeSupabase({ row: { ...ROW, merchant_name: '  SAFEWAY ' } })
    await pick()
    expect(calls.upserts[0].payload).toMatchObject({ merchant_key: 'safeway', merchant_label: 'SAFEWAY' })
  })

  it('learns from a re-pick on an already-picked row', async () => {
    const calls = makeSupabase({ row: { ...ROW, user_category: 'Food & Drink' } })
    expect(await (await pick()).json()).toEqual({ ok: true, learned: 'created' })
    expect(calls.upserts).toHaveLength(1)
  })

  it('answers exists, with the pick saved, when the merchant already has a rule', async () => {
    const calls = makeSupabase({ row: ROW, upsert: { data: [], error: null } })
    const res = await pick()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, learned: 'exists' })
    expect(calls.updates).toHaveLength(1)
  })

  it.each([
    ['a pick across the line', ROW, 'Income'],
    ['a row with no merchant name', { ...ROW, merchant_name: null }, 'Grocery'],
    ['a pick equal to the bank category', ROW, 'Food & Drink'],
  ])('learns nothing from %s', async (_, row, category) => {
    const calls = makeSupabase({
      row,
      categories: [
        { id: 'c1', name: 'Food & Drink', pfc_primary: 'FOOD_AND_DRINK', sort_order: 1 },
        { id: 'c2', name: 'Grocery', pfc_primary: null, sort_order: 2 },
        { id: 'c3', name: 'Income', pfc_primary: 'INCOME', sort_order: 3 },
      ],
    })
    const res = await pick(category)
    expect(await res.json()).toEqual({ ok: true, learned: 'no' })
    expect(calls.upserts).toHaveLength(0)
    expect(assertEnvMatchesDatabase).not.toHaveBeenCalled()
  })

  it('learns nothing from a TRANSFER_OUT row after "Transfer Out" is deleted', async () => {
    const calls = makeSupabase({
      row: { ...ROW, pfc_primary: 'TRANSFER_OUT', pfc_detailed: 'TRANSFER_OUT_ACCOUNT_TRANSFER' },
      categories: [
        { id: 'c1', name: 'Food & Drink', pfc_primary: 'FOOD_AND_DRINK', sort_order: 1 },
        { id: 'c2', name: 'Grocery', pfc_primary: null, sort_order: 2 },
        { id: 'c4', name: 'Transfer In', pfc_primary: 'TRANSFER_IN', sort_order: 4 },
      ],
    })
    expect(await (await pick('Grocery')).json()).toEqual({ ok: true, learned: 'no' })
    expect(await (await pick('Transfer In')).json()).toEqual({ ok: true, learned: 'no' })
    expect(calls.upserts).toHaveLength(0)
  })

  it('answers 400 on a card payment, with no upsert', async () => {
    const calls = makeSupabase({ row: { ...ROW, pfc_primary: 'LOAN_PAYMENTS', pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' } })
    expect((await pick()).status).toBe(400)
    expect(calls.upserts).toHaveLength(0)
  })

  it.each([
    ['a failed write', { error: { message: 'boom' }, count: null }],
    ['a write that matched no rows', { error: null, count: 0 }],
  ])('learns nothing after %s', async (_, update) => {
    const calls = makeSupabase({ row: ROW, update })
    await pick()
    expect(calls.upserts).toHaveLength(0)
    expect(assertEnvMatchesDatabase).not.toHaveBeenCalled()
  })

  it('answers 200 failed, with the pick saved, when the insert errors', async () => {
    const calls = makeSupabase({ row: ROW, upsert: { data: null, error: { code: '23503', message: 'fk violation' } } })
    const res = await pick()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, learned: 'failed' })
    expect(calls.updates).toHaveLength(1)
    expect(logs.some((l) => l[0] === '[categorize] learn failed')).toBe(true)
    expect(JSON.stringify(await (await pick()).json())).not.toContain('fk violation')
  })

  it('a thrown insert still answers 200 failed', async () => {
    makeSupabase({ row: ROW, upsert: 'throw' })
    const res = await pick()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, learned: 'failed' })
    expect(logs.some((l) => l[0] === '[categorize] learn failed')).toBe(true)
  })

  it('answers 200 skipped on an environment mismatch, with no insert', async () => {
    assertEnvMatchesDatabase.mockRejectedValueOnce(new EnvMismatchError('sandbox', 'production'))
    const calls = makeSupabase({ row: ROW })
    const res = await pick()
    expect(await res.json()).toEqual({ ok: true, learned: 'skipped' })
    expect(calls.updates).toHaveLength(1)
    expect(calls.upserts).toHaveLength(0)
    expect(logs.some((l) => l[0] === '[categorize] learn skipped: environment')).toBe(true)
  })

  it('answers 200 failed when the environment cannot be read, with no insert', async () => {
    assertEnvMatchesDatabase.mockRejectedValueOnce(new Error('could not read app_env: timeout'))
    const calls = makeSupabase({ row: ROW })
    const res = await pick()
    expect(await res.json()).toEqual({ ok: true, learned: 'failed' })
    expect(calls.updates).toHaveLength(1)
    expect(calls.upserts).toHaveLength(0)
    expect(logs.some((l) => l[0] === '[categorize] learn failed')).toBe(true)
  })
})
```

- [ ] **Step 3: Run the tests and watch them fail**

Run: `npx vitest run tests/unit/categorize-route.test.ts`
Expected: FAIL. The responses lack `learned`, and `calls.upserts` is empty.

- [ ] **Step 4: Implement**

In `app/api/transactions/categorize/route.ts`:

1. Imports become:

```ts
import { NextResponse } from 'next/server'
import { isAuthRetryableFetchError } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { isCardPaymentRow, CREDIT_CARD_PAYMENT_DETAILED, type Category } from '@/lib/categories'
import { buildKindContext, learnableRule } from '@/lib/category-rules'
import { assertEnvMatchesDatabase, EnvMismatchError } from '@/lib/app-env'
```

2. In the header comment, after the "Sets the category on ONE transaction" paragraph, add:

```ts
// Then, if that pick is the first for its merchant, it teaches a household rule (§6.1 step 8) that
// files the merchant's other rows the same way at read time. Learning never writes transactions,
// and a failed learn never fails the pick.
```

3. Step 3's comment loses its now-stale "except merchant_name and pfc_primary, which are read for learning" clause:

```ts
  // 3. Read the row. merchant_name and pfc_primary are for learning (step 8).
```

4. Replace the closing lines (from `// 9. Response` to the end of `POST`) with:

```ts
  // 8. Learn. After the write, so only a saved pick can teach.
  const learned = await learn(supabase, row, picked, cats ?? [])

  // 9. `learned` is for tests and logs; the UI shows nothing (spec decision 1).
  return NextResponse.json({ ok: true, learned })
}

type Learned = 'created' | 'exists' | 'no' | 'skipped' | 'failed'

// Spec §6.1 step 8. Never throws: the pick is already saved, and a learn that fails must not turn
// it into an error the picker would roll back.
async function learn(
  supabase: Awaited<ReturnType<typeof createClient>>,
  row: { household_id: string; merchant_name: string | null; pfc_primary: string | null; pfc_detailed: string | null },
  picked: Category,
  cats: Category[]
): Promise<Learned> {
  const rule = learnableRule(row, picked.name, buildKindContext(cats))
  if (!rule) return 'no'

  // Local and Preview run sandbox against the shared database, and must not create rules that
  // production then applies.
  try {
    await assertEnvMatchesDatabase()
  } catch (e) {
    if (e instanceof EnvMismatchError) {
      console.warn('[categorize] learn skipped: environment', e.message)
      return 'skipped'
    }
    console.error('[categorize] learn failed', e)
    return 'failed'
  }

  // INSERT … ON CONFLICT DO NOTHING RETURNING id: a row back means this pick created the rule. None
  // means the merchant already has one, so this pick stays a one-row exception (decision 3). The
  // unique (household_id, merchant_key) gives two partners' simultaneous first picks one rule.
  try {
    const { data, error } = await supabase
      .from('category_rules')
      .upsert(
        {
          household_id: row.household_id,
          merchant_key: rule.merchantKey,
          merchant_label: rule.merchantLabel,
          category_id: picked.id,
          origin: 'learned',
        },
        { onConflict: 'household_id,merchant_key', ignoreDuplicates: true }
      )
      .select('id')
    if (error) {
      // 23503 here is the category deleted between the read and the insert.
      console.error('[categorize] learn failed', error.code, error.message)
      return 'failed'
    }
    if (!data?.length) return 'exists'
    console.info('[categorize] learned', { merchant_key: rule.merchantKey, category: picked.name, rule: data[0].id })
    return 'created'
  } catch (e) {
    console.error('[categorize] learn failed', e)
    return 'failed'
  }
}
```

5. In `scripts/check-invariants.mjs`, update the two reason strings so they no longer say "PR 3 will":

```js
  ['app/api/transactions/categorize/route.ts', 'Validates a pick against the whole category list, and builds the kind gate for learning from it.'],
```
```js
  ['app/api/transactions/categorize/route.ts', 'Learns a rule from a first pick (spec §6.1 step 8).'],
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `npx vitest run tests/unit/categorize-route.test.ts tests/unit/check-invariants.test.ts && npm run check:invariants && npx tsc --noEmit`
Expected: PASS; invariants clean; no type errors.

- [ ] **Step 6: Commit**

```bash
git add app/api/transactions/categorize/route.ts tests/unit/categorize-route.test.ts scripts/check-invariants.mjs
git commit -m "Category learning, PR 3: a first pick teaches its merchant a rule (#28)"
```

---

### Task 3: Settings → Category rules speaks of learning again (spec §8.3)

**Files:**
- Modify: `components/CategoryRulesCard.tsx` (lines 27-41, the help text and empty state; the Remove dialog body near line 205)
- Test: `tests/unit/category-rules-card.test.tsx` (the tests at lines 66-75, 90-93 and 197-206)

**Interfaces:**
- Consumes: nothing new. `RuleView`, `RuleCategory` and the `matching`, `changed` and `pickedByHand` fields are unchanged.
- Produces: copy only.

- [ ] **Step 1: Change the tests to the spec's copy (they will fail)**

Replace the test `'explains rules without promising learning'` with:

```ts
  it('explains that a pick teaches', () => {
    render(<CategoryRulesCard rules={[safeway()]} categories={CATS} />)
    expect(
      screen.getByText(
        "When you pick a category for a merchant the app hasn't learned yet, it files that merchant's other transactions the same way, past and future. It never moves money between spending, transfers and income, and never touches card payments."
      )
    ).toBeTruthy()
  })
```

In `'shows the empty state'`, the expected text becomes:

```ts
    expect(
      screen.getByText('Nothing learned yet. Pick a category on a transaction and the app will remember it for that merchant.')
    ).toBeTruthy()
```

Replace `"Remove's dialog omits zero counts and promises no learning"` with:

```ts
  it("Remove's dialog omits zero counts and says the next pick teaches", () => {
    render(<CategoryRulesCard rules={[safeway({ pickedByHand: 0 })]} categories={CATS} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remove the Safeway rule' }))
    const dialog = screen.getByRole('dialog', { hidden: true })
    expect(within(dialog).getByText('Remove the Safeway rule?')).toBeTruthy()
    expect(within(dialog).getByText('145 Safeway transactions go back to their bank’s category.')).toBeTruthy()
    expect(within(dialog).queryByText(/picked by hand|keep theirs/)).toBeNull()
    expect(within(dialog).getByText('The next category you pick for Safeway will teach the app again.')).toBeTruthy()
  })
```

And add one case for a rule with no current transactions, so the line shows there too:

```ts
  it("Remove's dialog says the next pick teaches even with no current transactions", () => {
    render(<CategoryRulesCard rules={[safeway({ changed: 0, pickedByHand: 0, matching: 0 })]} categories={CATS} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remove the Safeway rule' }))
    const dialog = screen.getByRole('dialog', { hidden: true })
    expect(within(dialog).getByText('The next category you pick for Safeway will teach the app again.')).toBeTruthy()
    expect(
      within(dialog).getByText('No Safeway transactions are showing right now — for example, if a bank is disconnected.')
    ).toBeTruthy()
  })
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run tests/unit/category-rules-card.test.tsx`
Expected: FAIL on the three changed copies and the new case.

- [ ] **Step 3: Implement**

In `components/CategoryRulesCard.tsx`:

1. The component comment above `CategoryRulesCard` becomes:

```ts
// Settings → Category rules (#28 spec §8.3): every rule, with what it does, a Change of category
// within its kind, and Remove. Rules are created by a first pick on a transaction (spec §6.1 step 8)
// and by the one-time seed, never here.
```

2. Delete the `{/* PR 3 (#28 spec §6.1 step 8) restores … */}` comment, and replace the help paragraph's text:

```tsx
      <p className="text-sm text-muted">
        When you pick a category for a merchant the app hasn&apos;t learned yet, it files that merchant&apos;s other
        transactions the same way, past and future. It never moves money between spending, transfers and income, and
        never touches card payments.
      </p>
```

3. The empty state:

```tsx
        <p className="text-sm text-muted">
          Nothing learned yet. Pick a category on a transaction and the app will remember it for that merchant.
        </p>
```

4. In the `ConfirmDialog` body, after the `pickedByHand` lines and before the `matching === 0` line, add:

```tsx
        <p>The next category you pick for {label} will teach the app again.</p>
```

The spec orders the "next pick" line third, after the two counts; the "No … are showing" line stays last, as PR 2 placed it.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run tests/unit/category-rules-card.test.tsx`
Expected: PASS. (No other test quotes the old copy; checked 2026-10-09.)

- [ ] **Step 5: Commit**

```bash
git add components/CategoryRulesCard.tsx tests/unit/category-rules-card.test.tsx
git commit -m "Category learning, PR 3: Settings says a pick teaches, and Remove says the next one teaches again (#28)"
```

---

### Task 4: Verify, mutation-check, open the PR, and the production check

**Files:**
- Modify: `docs/superpowers/specs/2026-09-11-category-rules-design.md:6` (status line only)

- [ ] **Step 1: Status line**

Line 6 becomes:

```markdown
- **Status:** Rules design (§1–§13) approved in brainstorming on 2026-09-11 and revised after an adversarial review. Jev suggestions (§14) added and approved on 2026-10-07. PR 1 merged as #142, PR 2 as #146 (22 rules live since 2026-10-09). PR 3 (learning) is this branch.
```

- [ ] **Step 2: The full gate**

Run each and confirm that it passes:

```bash
npx vitest run
VITEST_TZ=America/Los_Angeles npx vitest run
npx tsc --noEmit
npm run lint
npm run check:invariants
npm run check:secrets
npx next build
```

- [ ] **Step 3: Mutation checks.** For each, make the change, run the named test file, see the named test fail, then restore it with `git checkout -- <file>`. Record the results in the PR body.

| Mutation (one at a time) | File | Test that must fail |
| --- | --- | --- |
| Drop `isCardPaymentRow(row.pfc_detailed) \|\|` from `learnableRule` | `lib/category-rules.ts` | `teaches nothing on a card payment…` and the agreement property |
| Drop `kind !== bank.kind \|\|` | same | `…after "Transfer Out" is deleted`, the agreement property |
| Drop `kind !== kindOf(bank.name, k) \|\|` | same | `…after "Transfer Out" is deleted` (Transfer In case), the agreement property |
| Drop `\|\| pickedName === bank.name` | same | `teaches nothing when the pick equals the bank category`, the agreement property |
| `merchantLabel: row.merchant_name ?? ''` (no trim) | same | `trims the label and lowercases the key` |
| Delete the `assertEnvMatchesDatabase` try block | route | `answers 200 skipped on an environment mismatch…` |
| `ignoreDuplicates: false` | route | `creates the rule with the exact payload and options` |
| Remove the outer `try`/`catch` around the insert | route | `a thrown insert still answers 200 failed` |
| `if (!data?.length) return 'created'` (swapped) | route | `answers exists…` and `creates the rule…` |
| Move `learn(...)` above the step 6 update | route | `learns nothing after a failed write` |
| Delete the "teach again" `<p>` | card | `Remove's dialog … says the next pick teaches` (both) |

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin 28-category-rules-pr3
gh pr create --title "Category learning, PR 3: a first pick teaches its merchant a rule (#28)" --body-file <scratchpad>/pr3-body.md
```

The body says what changed, lists the mutation results, links the spec and this plan, and includes the Step 5 checklist below for after the merge. It ends with the session's attribution lines.

- [ ] **Step 5: After the merge and deploy: the production check (spec §10.2 step 5).** Learning can only be exercised on production, because the insert is environment-guarded. The owner does this; the agent prepares the SQL.

1. **Find a candidate.** Find a merchant with exactly one non-removed transaction, no hand pick and no rule, whose true category differs from its bank category, and which the household would want to keep that way:
   ```sql
   select t.merchant_name, t.date, t.amount, t.pfc_primary, t.user_category
   from public.transactions t
   where t.removed = false and t.merchant_name is not null
     and t.pfc_detailed is distinct from 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT'
     and lower(regexp_replace(t.merchant_name, '^\s+|\s+$', '', 'g')) in (
       select lower(regexp_replace(merchant_name, '^\s+|\s+$', '', 'g')) from public.transactions
       where removed = false and merchant_name is not null
       group by 1 having count(*) = 1)
     and not exists (select 1 from public.category_rules r
       where r.merchant_key = lower(regexp_replace(t.merchant_name, '^\s+|\s+$', '', 'g')))
   order by t.date desc limit 30;
   ```
   The owner picks one, and the category it truly belongs in. A pick can't be cleared (decision 7).
2. **Record** the current month's Spent, Income and Saved tiles.
3. **Pick it on the phone.** The pick saves, and nothing on screen changes except that row.
4. **Confirm the rule** (read-only):
   ```sql
   select merchant_key, merchant_label, c.name, origin, r.created_at
   from public.category_rules r join public.categories c on c.id = r.category_id
   where origin = 'learned' order by r.created_at desc limit 5;
   ```
   Expect one `learned` row for that merchant. The Vercel log shows `[categorize] learned`.
5. **Settings → Category rules** lists it as "learned from a pick", with "No current transactions" or "0 transactions". The only row is hand-picked, so it isn't counted under "changed".
6. **Change** the rule to another same-kind category, then **Remove** it. The dialog says the next pick teaches again.
7. **Confirm no rule remains** for that merchant (re-run step 4's query), and that Spent, Income and Saved equal step 2's figures.
8. Update the #28 memory and comment the result on #28. If everything held, close #28's rules phase; PR 4 (Jev) stays open.

---

## Self-review (done while writing)

- **Spec coverage.** §6.1 step 8: the gate (Task 1), the environment guard, the upsert and its outcomes, failure never failing the pick (Task 2). Step 9's `learned` field: Task 2. The §11 PR 3 list: exact payload and options; `created`; no learning for crossing, null merchant, pick equal to bank, and `TRANSFER_OUT` after deletion; card payment `400` with no upsert; `exists` with the pick saved; upsert error `200 failed` plus the tag; mismatch `200 skipped`; unreadable environment `200 failed`. All are in Task 2, and the gate cases are also in Task 1. §8.3's help text, empty state and "teach again" line: Task 3. §10.2 step 5: Task 4, Step 5. §14.6's "the pick teaches a rule as any pick does" holds by construction; PR 4 changes nothing here.
- **Placeholders.** None. The only variable is `<scratchpad>` for the PR body path.
- **Names.** `learnableRule`, `LearnableRule`, `merchantKey`/`merchantLabel` (camelCase in the type; snake_case in the database payload), `Learned`, and `learn()` are used the same way throughout.
- **Review Focus.** All five have tests in Tasks 1 and 2.
