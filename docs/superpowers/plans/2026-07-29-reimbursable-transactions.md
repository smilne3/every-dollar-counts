# Reimbursable Transactions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a transaction be marked fully or partly reimbursable, grouped under a named claim and attributed per person, so reimbursable money never counts as spending and outstanding amounts are visible per debtor.

**Architecture:** Three new tables (`reimbursement_claims`, `reimbursement_splits`, `reimbursement_write_offs`). A split is a row saying "this much of this transaction belongs to this claim, owed by this person"; the unsplit remainder is your spending. One pure helper `spendableAmount` encodes the whole rule, and the three existing spending functions route through it via a shared `SpendContext`.

**Tech Stack:** Next.js 16.2.10 App Router (server components), TypeScript, Supabase (Postgres + RLS), Vitest 4, Tailwind 4.

**Spec:** `docs/superpowers/specs/2026-07-29-reimbursable-transactions-design.md` — read it before starting. Issue #27.

## Global Constraints

- **Plaid sign convention:** `amount > 0` is money OUT, `amount < 0` is money IN. Every calculation in this plan depends on it.
- **No closed month's numbers may change retroactively.** Reimbursable money is excluded from spending the moment it is marked; write-offs land in the write-off month, never the original.
- **Never write synthetic rows to `transactions`.** The user's ledger must keep matching their bank statement. Write-offs are synthesised in memory at read time only.
- **RLS on every new table:** `household_id in (select private.household_ids())` for `using` and `with check`, matching `db/migrations/011_manual_assets.sql`.
- **Category values are NAMES (text), not ids** — budgets and `user_category` already work this way (`db/migrations/007_categories.sql:2`).
- **Tests:** Vitest, files in `tests/unit/**/*.test.ts`, run with `npx vitest run`. Import via the `@/` alias.
- **Migrations are applied by hand** in the Supabase SQL editor; there is no migration runner in this repo.
- **Money is `numeric` in Postgres** and arrives as a JS number. Use `toBeCloseTo` in tests for non-integer money.
- **Do not add `plaid_env` scoping.** The existing money reads don't scope by it — that is open bug #23. New queries must match the existing reads exactly so this feature neither worsens nor half-fixes #23. Fixing it is its own issue.
- **`ConfirmDialog` props** (`components/ui/ConfirmDialog.tsx:13-29`) are `open`, `title`, `children`, `confirmLabel`, `busy`, `onConfirm`, `onCancel`. The body text goes in `children` — there is no `message` prop.

---

### Task 1: Database schema

**Files:**
- Create: `db/migrations/012_reimbursements.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: tables `reimbursement_claims`, `reimbursement_splits`, `reimbursement_write_offs`. Later tasks read/write these column names exactly.

- [ ] **Step 1: Write the migration**

```sql
-- Phase 7: reimbursable transactions (#27).
-- A split says "this much of this transaction is owed back to me, under this claim, by this person".
-- The UNSPLIT remainder of a transaction is the user's own spending — there is deliberately no
-- "my portion" column, so it can never disagree with the splits.

create table if not exists reimbursement_claims (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  name text not null,
  -- null = open, set = written off. There is deliberately no `status` column: "settled" is DERIVED
  -- from the totals (outstanding <= 0), so it cannot drift from the splits it summarises.
  written_off_on date,
  created_at timestamptz default now(),
  unique (household_id, name)
);

create table if not exists reimbursement_splits (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  transaction_id uuid not null references transactions(id) on delete cascade,
  claim_id uuid not null references reimbursement_claims(id) on delete cascade,
  owed_by text,                       -- nullable; the person axis. Free text.
  amount numeric not null check (amount > 0),
  created_at timestamptz default now()
);
create index if not exists reimbursement_splits_txn_idx on reimbursement_splits (transaction_id);
create index if not exists reimbursement_splits_claim_idx on reimbursement_splits (claim_id);

-- A write-off is FROZEN at the moment the user gives up on a claim: the unreturned amount, allocated
-- pro-rata across the categories it came from, dated the write-off day. Frozen rather than derived so
-- that later editing a split cannot rewrite a month that has already closed.
create table if not exists reimbursement_write_offs (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  claim_id uuid not null references reimbursement_claims(id) on delete cascade,
  category text not null,             -- effective-category NAME, as budgets store it
  amount numeric not null,
  date date not null                  -- the write-off date, NOT the original expense date
);
create index if not exists reimbursement_write_offs_date_idx on reimbursement_write_offs (date);

alter table reimbursement_claims enable row level security;
drop policy if exists "manage your claims" on reimbursement_claims;
create policy "manage your claims" on reimbursement_claims
  for all to authenticated
  using ( household_id in (select private.household_ids()) )
  with check ( household_id in (select private.household_ids()) );

alter table reimbursement_splits enable row level security;
drop policy if exists "manage your splits" on reimbursement_splits;
create policy "manage your splits" on reimbursement_splits
  for all to authenticated
  using ( household_id in (select private.household_ids()) )
  with check ( household_id in (select private.household_ids()) );

alter table reimbursement_write_offs enable row level security;
drop policy if exists "manage your write-offs" on reimbursement_write_offs;
create policy "manage your write-offs" on reimbursement_write_offs
  for all to authenticated
  using ( household_id in (select private.household_ids()) )
  with check ( household_id in (select private.household_ids()) );
```

- [ ] **Step 2: Apply it**

Paste the file into the Supabase SQL editor and run it. It is idempotent (`if not exists`, `drop policy if exists`), so re-running is safe.

- [ ] **Step 3: Verify the tables and policies exist**

Run in the SQL editor:

```sql
select tablename, rowsecurity from pg_tables
where tablename like 'reimbursement%';
```

Expected: three rows, `rowsecurity = true` for all three.

- [ ] **Step 4: Commit**

```bash
git add db/migrations/012_reimbursements.sql
git commit -m "feat(db): reimbursement claims, splits and write-offs (#27)"
```

---

### Task 2: The core spending rule

**Files:**
- Create: `lib/reimbursements.ts`
- Test: `tests/unit/reimbursements.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type Split = { transaction_id: string; claim_id: string; owed_by: string | null; amount: number }`
  - `type Claim = { id: string; name: string; written_off_on: string | null }`
  - `type WriteOff = { claim_id: string; category: string; amount: number; date: string }`
  - `reimbursedByTxn(splits: Split[]): Record<string, number>`
  - `spendableAmount(t: { id: string; amount: number }, reimbursed: Record<string, number>): number`
  - `writeOffsAsTxns(writeOffs: WriteOff[]): WriteOffTxn[]` where
    `type WriteOffTxn = { id: string; amount: number; date: string; user_category: string; pfc_primary: null; pfc_detailed: null }`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/reimbursements.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  reimbursedByTxn,
  spendableAmount,
  writeOffsAsTxns,
  type Split,
} from '@/lib/reimbursements'

const split = (transaction_id: string, amount: number, owed_by: string | null = null): Split => ({
  transaction_id,
  claim_id: 'claim-1',
  owed_by,
  amount,
})

describe('reimbursedByTxn', () => {
  it('sums split amounts per transaction', () => {
    const r = reimbursedByTxn([
      split('t1', 250, 'Dave'),
      split('t1', 250, 'Sam'),
      split('t1', 250, 'Priya'),
      split('t2', 400),
    ])
    expect(r['t1']).toBeCloseTo(750)
    expect(r['t2']).toBeCloseTo(400)
  })

  it('is an empty map for no splits', () => {
    expect(reimbursedByTxn([])).toEqual({})
  })
})

describe('spendableAmount', () => {
  // The $1,000 rental split three ways: only the unsplit $250 is the user's spending.
  it('reduces an outflow by its reimbursable portion', () => {
    const r = reimbursedByTxn([split('t1', 250), split('t1', 250), split('t1', 250)])
    expect(spendableAmount({ id: 't1', amount: 1000 }, r)).toBeCloseTo(250)
  })

  // The $500 work dinner with $400 back: $100 is really the user's.
  it('handles a partial reimbursable', () => {
    const r = reimbursedByTxn([split('t1', 400)])
    expect(spendableAmount({ id: 't1', amount: 500 }, r)).toBeCloseTo(100)
  })

  it('zeroes a fully reimbursable outflow', () => {
    const r = reimbursedByTxn([split('t1', 500)])
    expect(spendableAmount({ id: 't1', amount: 500 }, r)).toBe(0)
  })

  // A repayment inflow is flow-NEUTRAL: not income, not negative spending.
  it('zeroes a fully tagged repayment inflow', () => {
    const r = reimbursedByTxn([split('t1', 250)])
    expect(spendableAmount({ id: 't1', amount: -250 }, r)).toBe(0)
  })

  // Dave rounds $250 up to $260. The tagged $250 is neutral; the $10 surplus stays an inflow and is
  // then treated exactly as any untagged $10 inflow of that category would be.
  it('leaves the surplus of an over-tagged repayment as an inflow', () => {
    const r = reimbursedByTxn([split('t1', 250)])
    expect(spendableAmount({ id: 't1', amount: -260 }, r)).toBeCloseTo(-10)
  })

  // This is what makes the whole refactor safe: no splits must be a perfect no-op.
  it('returns an untouched transaction unchanged', () => {
    expect(spendableAmount({ id: 't1', amount: 42.5 }, {})).toBe(42.5)
    expect(spendableAmount({ id: 't1', amount: -42.5 }, {})).toBe(-42.5)
  })

  it('never flips sign even if splits somehow exceed the amount', () => {
    const r = reimbursedByTxn([split('t1', 9999)])
    expect(spendableAmount({ id: 't1', amount: 100 }, r)).toBe(0)
    expect(spendableAmount({ id: 't1', amount: -100 }, r)).toBe(0)
  })
})

describe('writeOffsAsTxns', () => {
  it('maps a write-off into a transaction-shaped value in its stored category', () => {
    const r = writeOffsAsTxns([
      { claim_id: 'c1', category: 'Food & Drink', amount: 540, date: '2026-11-03' },
    ])
    expect(r).toHaveLength(1)
    expect(r[0].amount).toBeCloseTo(540)
    expect(r[0].date).toBe('2026-11-03')
    // user_category is how effectiveCategory picks it up, with no PFC mapping involved.
    expect(r[0].user_category).toBe('Food & Drink')
    expect(r[0].pfc_primary).toBeNull()
  })

  it('gives each write-off an id that can never collide with a real transaction id', () => {
    const r = writeOffsAsTxns([
      { claim_id: 'c1', category: 'Travel', amount: 100, date: '2026-11-03' },
      { claim_id: 'c1', category: 'Food & Drink', amount: 50, date: '2026-11-03' },
    ])
    const ids = r.map((x) => x.id)
    expect(new Set(ids).size).toBe(2)
    // Real transaction ids are uuids, so a prefixed id cannot pick up a real split.
    for (const id of ids) expect(id.startsWith('writeoff:')).toBe(true)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/reimbursements.test.ts`
Expected: FAIL — cannot resolve `@/lib/reimbursements`.

- [ ] **Step 3: Write the implementation**

Create `lib/reimbursements.ts`:

```ts
// Reimbursable transactions (#27). A SPLIT says "this much of this transaction is owed back to me,
// under this claim, by this person". The UNSPLIT remainder of a transaction is the user's own
// spending, so there is no "my portion" field anywhere that could disagree with the splits.

export type Split = {
  transaction_id: string
  claim_id: string
  owed_by: string | null
  amount: number
}

export type Claim = {
  id: string
  name: string
  written_off_on: string | null // null = open; set = written off
}

export type WriteOff = {
  claim_id: string
  category: string // effective-category NAME
  amount: number
  date: string // the write-off date, not the original expense date
}

// Transaction-shaped value synthesised from a write-off. Never persisted to `transactions`.
export type WriteOffTxn = {
  id: string
  amount: number
  date: string
  user_category: string
  pfc_primary: null
  pfc_detailed: null
}

// Split amounts summed per transaction id.
export function reimbursedByTxn(splits: Split[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const s of splits) {
    out[s.transaction_id] = (out[s.transaction_id] ?? 0) + s.amount
  }
  return out
}

// THE rule, in one expression: splits pull a transaction's contribution toward zero, in whichever
// direction it already points (Plaid: amount > 0 is money out).
//   $1,000 outflow, $750 split  ->  $250 of spending
//   -$260 repayment, $250 split -> -$10, so the surplus stays an inflow and is treated exactly as
//                                  any untagged $10 inflow of that category would be
// A transaction with no splits is returned untouched, which is what makes an empty split map a
// provable no-op for every caller.
export function spendableAmount(
  t: { id: string; amount: number },
  reimbursed: Record<string, number>
): number {
  const r = reimbursed[t.id] ?? 0
  if (!r) return t.amount
  const net = Math.max(0, Math.abs(t.amount) - r)
  return t.amount < 0 ? -net : net
}

// Write-offs become in-memory transactions so the three spending functions need no write-off logic
// of their own: `effectiveCategory` honours user_category first, so each row lands in the category
// it was allocated to. NOTHING here is written to `transactions` — the user's ledger must keep
// matching their bank statement.
export function writeOffsAsTxns(writeOffs: WriteOff[]): WriteOffTxn[] {
  return writeOffs.map((w, i) => ({
    // Prefixed so it can never collide with a real (uuid) transaction id and therefore can never
    // pick up a split. The index keeps multi-category write-offs distinct.
    id: `writeoff:${w.claim_id}:${i}`,
    amount: w.amount,
    date: w.date,
    user_category: w.category,
    pfc_primary: null,
    pfc_detailed: null,
  }))
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/reimbursements.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/reimbursements.ts tests/unit/reimbursements.test.ts
git commit -m "feat: spendableAmount, the one rule for reimbursable money (#27)"
```

---

### Task 3: The shared spend context

**Files:**
- Create: `lib/spend-context.ts`
- Test: `tests/unit/spend-context.test.ts`

**Interfaces:**
- Consumes: `Split`, `reimbursedByTxn` from `lib/reimbursements` (Task 2); `Category`, `pfcToName`, `nonSpendingNames`, `transferNames` from `lib/categories`.
- Produces:
  - `type SpendContext = { pfcMap: Record<string, string>; nonSpending: Set<string>; transfers: Set<string>; reimbursedByTxn: Record<string, number> }`
  - `buildSpendContext(input: { categories: Category[]; splits: Split[] }): SpendContext`

**Why this exists:** the five money surfaces each assemble these arguments by hand today. A page that forgot to pass `reimbursedByTxn` would still compile and quietly report reimbursable money as spending. One context object turns that class of drift into a type error.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/spend-context.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildSpendContext } from '@/lib/spend-context'
import type { Category } from '@/lib/categories'

const categories: Category[] = [
  { id: '1', name: 'Income', pfc_primary: 'INCOME', sort_order: 0 },
  { id: '2', name: 'Transfer In', pfc_primary: 'TRANSFER_IN', sort_order: 1 },
  { id: '3', name: 'Food & Drink', pfc_primary: 'FOOD_AND_DRINK', sort_order: 2 },
  { id: '4', name: 'Reimbursable-ish custom', pfc_primary: null, sort_order: 3 },
]

describe('buildSpendContext', () => {
  it('derives the pfc map, the exclusion sets and the split totals in one pass', () => {
    const ctx = buildSpendContext({
      categories,
      splits: [
        { transaction_id: 't1', claim_id: 'c1', owed_by: 'Dave', amount: 250 },
        { transaction_id: 't1', claim_id: 'c1', owed_by: 'Sam', amount: 250 },
      ],
    })
    expect(ctx.pfcMap['FOOD_AND_DRINK']).toBe('Food & Drink')
    expect(ctx.nonSpending.has('Income')).toBe(true)
    expect(ctx.nonSpending.has('Transfer In')).toBe(true)
    expect(ctx.nonSpending.has('Food & Drink')).toBe(false)
    expect(ctx.transfers.has('Transfer In')).toBe(true)
    expect(ctx.transfers.has('Income')).toBe(false)
    expect(ctx.reimbursedByTxn['t1']).toBeCloseTo(500)
  })

  it('builds a usable context with no splits at all', () => {
    const ctx = buildSpendContext({ categories, splits: [] })
    expect(ctx.reimbursedByTxn).toEqual({})
    expect(ctx.pfcMap['INCOME']).toBe('Income')
  })

  // A custom category (pfc_primary null) is spending — it is neither income nor a transfer.
  it('treats a custom category as spending', () => {
    const ctx = buildSpendContext({ categories, splits: [] })
    expect(ctx.nonSpending.has('Reimbursable-ish custom')).toBe(false)
    expect(ctx.transfers.has('Reimbursable-ish custom')).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/spend-context.test.ts`
Expected: FAIL — cannot resolve `@/lib/spend-context`.

- [ ] **Step 3: Write the implementation**

Create `lib/spend-context.ts`:

```ts
import { pfcToName, nonSpendingNames, transferNames, type Category } from './categories'
import { reimbursedByTxn, type Split } from './reimbursements'

// Everything the spending calculations need, assembled once per page. Bundled into one object
// because the five money surfaces used to assemble these by hand: a page that forgot to pass the
// split totals would still compile and silently report reimbursable money as spending.
export type SpendContext = {
  pfcMap: Record<string, string> // Plaid PFC primary -> category NAME
  nonSpending: Set<string> // income + transfers (excluded from spending)
  transfers: Set<string> // transfers only (excluded from income too)
  reimbursedByTxn: Record<string, number> // transaction id -> reimbursable amount
}

export function buildSpendContext(input: {
  categories: Category[]
  splits: Split[]
}): SpendContext {
  return {
    pfcMap: pfcToName(input.categories),
    nonSpending: nonSpendingNames(input.categories),
    transfers: transferNames(input.categories),
    reimbursedByTxn: reimbursedByTxn(input.splits),
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/spend-context.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/spend-context.ts tests/unit/spend-context.test.ts
git commit -m "feat: SpendContext, one object for every money calculation (#27)"
```

---

### Task 4: Route `lib/budget.ts` through the context

This task changes two exported signatures **and** every page that calls them, so that the build is green at the end. Do not split it — a half-done signature change leaves the repo uncompilable.

**Files:**
- Modify: `lib/budget.ts` (`Txn` type, `spendByCategory`, `spendThisVsLast`)
- Modify: `tests/unit/budget.test.ts`
- Modify: `app/(app)/budgets/page.tsx:26-34`
- Modify: `app/(app)/trends/page.tsx:25-50`
- Modify: `app/(app)/breakdown/[metric]/page.tsx:107-114`
- Modify: `app/(app)/dashboard/page.tsx:97-117`

**Interfaces:**
- Consumes: `SpendContext`, `buildSpendContext` (Task 3); `writeOffsAsTxns`, `WriteOffTxn` (Task 2).
- Produces:
  - `type Txn = { id: string; amount: number; date: string; user_category: string | null; pfc_primary: string | null; pfc_detailed: string | null }`
  - `spendByCategory(txns: Txn[], ctx: SpendContext): Record<string, number>`
  - `spendThisVsLast(txns: Txn[], thisM: string, lastM: string, ctx: SpendContext, throughDay: number): { thisMonth: Record<string, number>; lastMonth: Record<string, number> }`

- [ ] **Step 1: Update the existing tests to the new signature, and add reimbursable cases**

In `tests/unit/budget.test.ts`, replace the header block (lines 1-25) with:

```ts
import { describe, it, expect } from 'vitest'
import { spendByCategory, budgetedSpend, progress, spendThisVsLast, monthKey } from '@/lib/budget'
import type { SpendContext } from '@/lib/spend-context'

const pfcMap: Record<string, string> = {
  FOOD_AND_DRINK: 'Food & Drink',
  TRANSPORTATION: 'Transportation',
  INCOME: 'Income',
  TRANSFER_OUT: 'Transfer Out',
  ENTERTAINMENT: 'Entertainment',
}
const nonSpending = new Set(['Income', 'Transfer In', 'Transfer Out'])

// A context with no reimbursables — the baseline every pre-existing test uses. These tests passing
// unchanged is the proof that an empty split map is a no-op.
const ctx = (
  over: Partial<SpendContext> = {},
  map: Record<string, string> = pfcMap
): SpendContext => ({
  pfcMap: map,
  nonSpending,
  transfers: new Set(['Transfer In', 'Transfer Out']),
  reimbursedByTxn: {},
  ...over,
})

let seq = 0
const t = (
  amount: number,
  date: string,
  pfc: string,
  override: string | null = null,
  pfc_detailed: string | null = null,
  id: string = `t${++seq}`
) => ({
  id,
  amount,
  date,
  pfc_primary: pfc,
  pfc_detailed,
  user_category: override,
})
```

Then update every existing call site in that file: `spendByCategory([...], pfcMap, nonSpending)` becomes `spendByCategory([...], ctx())`, and the one that overrides the map — currently `{ ...pfcMap, LOAN_PAYMENTS: 'Loan Payments' }` and `{ ...pfcMap, TRAVEL: 'Travel' }` — becomes `ctx({}, { ...pfcMap, LOAN_PAYMENTS: 'Loan Payments' })` and `ctx({}, { ...pfcMap, TRAVEL: 'Travel' })`. The two `spendThisVsLast(...)` calls change from `(list, thisM, lastM, pfcMap, nonSpending, day)` to `(list, thisM, lastM, ctx(), day)`.

Append these new cases inside the `describe('spendByCategory')` block:

```ts
  // #27: the $1,000 rental split three ways. Only the unsplit $250 is the user's spending.
  it('counts only the unsplit remainder of a reimbursable outflow', () => {
    const rental = t(1000, '2026-07-04', 'TRAVEL', null, null, 'rental')
    const r = spendByCategory(
      [rental],
      ctx({ reimbursedByTxn: { rental: 750 } }, { ...pfcMap, TRAVEL: 'Travel' })
    )
    expect(r['Travel']).toBeCloseTo(250)
  })

  // A repayment tagged to a claim is flow-neutral: it must NOT net the category down like a refund.
  it('ignores a fully tagged repayment inflow', () => {
    const rental = t(1000, '2026-07-04', 'TRAVEL', null, null, 'rental')
    const repay = t(-250, '2026-08-03', 'TRAVEL', null, null, 'repay')
    const r = spendByCategory(
      [rental, repay],
      ctx({ reimbursedByTxn: { rental: 750, repay: 250 } }, { ...pfcMap, TRAVEL: 'Travel' })
    )
    // 250 of real spending, and the repayment contributes nothing at all.
    expect(r['Travel']).toBeCloseTo(250)
  })

  // A written-off claim arrives as a synthesised transaction in its allocated category.
  it('counts a write-off as spending in its allocated category', () => {
    const r = spendByCategory(
      [
        {
          id: 'writeoff:c1:0',
          amount: 540,
          date: '2026-11-03',
          user_category: 'Food & Drink',
          pfc_primary: null,
          pfc_detailed: null,
        },
      ],
      ctx()
    )
    expect(r['Food & Drink']).toBeCloseTo(540)
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/budget.test.ts`
Expected: FAIL — `spendByCategory` still expects 3 arguments, and the new reimbursable tests report the full $1,000.

- [ ] **Step 3: Change `lib/budget.ts`**

Replace lines 1-33 of `lib/budget.ts` with:

```ts
import { effectiveCategory } from './effective-category'
import { isCreditCardPayment } from './categories'
import { spendableAmount } from './reimbursements'
import type { SpendContext } from './spend-context'

export type Txn = {
  id: string
  amount: number
  date: string
  user_category: string | null
  pfc_primary: string | null
  pfc_detailed: string | null
}

// 'YYYY-MM' bucket for a 'YYYY-MM-DD' date.
export function monthKey(date: string): string {
  return date.slice(0, 7)
}

// Sum spending per effective category NAME, net of anything reimbursable (#27).
export function spendByCategory(txns: Txn[], ctx: SpendContext): Record<string, number> {
  const out: Record<string, number> = {}
  for (const t of txns) {
    if (isCreditCardPayment(t)) continue // internal transfer, not spending
    const cat = effectiveCategory(t, ctx.pfcMap)
    if (ctx.nonSpending.has(cat)) continue // income + transfers
    // spendableAmount, not t.amount: the reimbursable portion is not the user's spending, and a
    // tagged repayment contributes 0 rather than netting the category down like a refund.
    // Outflows add; genuine refunds (untagged inflows in a spending category) still net down.
    out[cat] = (out[cat] ?? 0) + spendableAmount(t, ctx.reimbursedByTxn)
  }
  return out
}
```

Then replace the body of `spendThisVsLast` (currently lines 58-81) with:

```ts
export function spendThisVsLast(
  txns: Txn[],
  thisM: string,
  lastM: string,
  ctx: SpendContext,
  throughDay: number
) {
  const thisMonth: Record<string, number> = {}
  const lastMonth: Record<string, number> = {}
  for (const t of txns) {
    if (isCreditCardPayment(t)) continue // internal transfer, not spending
    const cat = effectiveCategory(t, ctx.pfcMap)
    if (ctx.nonSpending.has(cat)) continue // income + transfers
    const mk = monthKey(t.date)
    const amt = spendableAmount(t, ctx.reimbursedByTxn) // net of reimbursables (#27)
    if (mk === thisM) {
      thisMonth[cat] = (thisMonth[cat] ?? 0) + amt
    } else if (mk === lastM && dayOfMonth(t.date) <= throughDay) {
      lastMonth[cat] = (lastMonth[cat] ?? 0) + amt
    }
  }
  return { thisMonth, lastMonth }
}
```

Leave the comment block above `spendThisVsLast` (the #9 explanation) and the `dayOfMonth`, `budgetedSpend` and `progress` functions untouched.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/budget.test.ts`
Expected: PASS — all pre-existing cases plus the three new ones.

- [ ] **Step 5: Update the four calling pages**

In each page, add `id` to the transaction `select`, fetch splits and write-offs, build the context, and concatenate the synthesised write-offs onto the transaction list *before* the month filtering that already happens.

`app/(app)/budgets/page.tsx` — replace lines 26-34. This page already computes `monthStart` and `nextMonthStart` (lines 13-15); reuse them rather than inventing new date variables:

```tsx
  const { data: txns } = await supabase
    .from('transactions')
    .select('id, amount, date, user_category, pfc_primary, pfc_detailed')
    .eq('removed', false)
    .gte('date', monthStart)
    .lt('date', nextMonthStart)

  const { data: splitRows } = await supabase
    .from('reimbursement_splits')
    .select('transaction_id, claim_id, owed_by, amount')
  const { data: writeOffRows } = await supabase
    .from('reimbursement_write_offs')
    .select('claim_id, category, amount, date')
    .gte('date', monthStart)
    .lt('date', nextMonthStart)

  const { data: budgets } = await supabase.from('budgets').select('category, monthly_limit')

  const ctx = buildSpendContext({ categories, splits: (splitRows ?? []) as Split[] })
  // A written-off claim is spending in the month it was written off, so it joins the list here.
  const withWriteOffs = [...(txns ?? []), ...writeOffsAsTxns((writeOffRows ?? []) as WriteOff[])]
  const spend = spendByCategory(withWriteOffs, ctx)
```

Delete the now-unused `pfcMap` and `nonSpending` locals (lines 22-23) if nothing else on the page reads them; keep `categoryNames` from `spendingCategoryNames`, which drives the budget editor's dropdown rather than any calculation.

Add to its imports:

```tsx
import { buildSpendContext } from '@/lib/spend-context'
import { writeOffsAsTxns, type Split, type WriteOff } from '@/lib/reimbursements'
```

Apply the same three changes to `app/(app)/trends/page.tsx` (add `id` at line 27, fetch splits + write-offs for `>= ${lastM}-01`, build `ctx`, concatenate before the two existing `monthKey` filters, and pass `ctx` to both `spendByCategory` and `spendThisVsLast`), to `app/(app)/breakdown/[metric]/page.tsx:107-114`, and to `app/(app)/dashboard/page.tsx:97-117` (its `select` at line 99 and the `spendByCategory` at line 117).

- [ ] **Step 6: Verify the build and the whole suite**

```bash
npx tsc --noEmit && npx vitest run && npm run lint && npm run build
```

Expected: all green. If `tsc` reports a page still passing `pfcMap, nonSpending` positionally, that page was missed in Step 5.

- [ ] **Step 7: Commit**

```bash
git add lib/budget.ts tests/unit/budget.test.ts "app/(app)/budgets/page.tsx" "app/(app)/trends/page.tsx" "app/(app)/breakdown/[metric]/page.tsx" "app/(app)/dashboard/page.tsx"
git commit -m "refactor: route spendByCategory and spendThisVsLast through SpendContext (#27)"
```

---

### Task 5: Route `monthlyFlows` through the context

**Files:**
- Modify: `lib/dashboard.ts` (`FlowTxn` type, `monthlyFlows`)
- Modify: `tests/unit/dashboard.test.ts`
- Modify: `app/(app)/dashboard/page.tsx:102`
- Modify: `app/(app)/breakdown/[metric]/page.tsx:126`

**Interfaces:**
- Consumes: `SpendContext` (Task 3), `spendableAmount` (Task 2).
- Produces: `monthlyFlows(txns: FlowTxn[], ctx: SpendContext, months: { key: string; label: string }[]): { key: string; label: string; spending: number; income: number }[]`, and `FlowTxn` gains `id: string`.

Note the parameter reduction: the old `(txns, pfcMap, spendingExclude, incomeExclude, months)` collapses to `(txns, ctx, months)` because `ctx.nonSpending` and `ctx.transfers` are exactly the two exclusion sets.

- [ ] **Step 1: Update the tests and add reimbursable cases**

In `tests/unit/dashboard.test.ts`, replace the `describe('monthlyFlows')` setup (the `pfcMap`, `spendingExclude`, `incomeExclude` consts) with:

```ts
  const pfcMap = {
    FOOD_AND_DRINK: 'Food & Drink',
    TRAVEL: 'Travel',
    INCOME: 'Income',
    TRANSFER_IN: 'Transfer In',
  }
  const ctx = (reimbursedByTxn: Record<string, number> = {}) => ({
    pfcMap,
    nonSpending: new Set(['Income', 'Transfer In']),
    transfers: new Set(['Transfer In']),
    reimbursedByTxn,
  })
```

Give every `FlowTxn` fixture in that block an `id` (`id: 'f1'`, `'f2'`, …), change each `monthlyFlows(txns, pfcMap, spendingExclude, incomeExclude, months)` call to `monthlyFlows(txns, ctx(), months)`, and append:

```ts
  it('counts only the unsplit remainder of a reimbursable outflow', () => {
    const flows = monthlyFlows(
      [
        {
          id: 'rental',
          amount: 1000,
          date: '2026-07-04',
          user_category: null,
          pfc_primary: 'TRAVEL',
          pfc_detailed: null,
        },
      ],
      ctx({ rental: 750 }),
      months
    )
    expect(flows[1].spending).toBeCloseTo(250)
  })

  // The cross-month case #27 exists to fix: fronting money in July and being repaid in August must
  // leave BOTH months undistorted — no July spike, and no negative August spending.
  it('leaves both months clean across a cross-month reimbursement', () => {
    const flows = monthlyFlows(
      [
        {
          id: 'flight',
          amount: 500,
          date: '2026-06-04',
          user_category: null,
          pfc_primary: 'TRAVEL',
          pfc_detailed: null,
        },
        {
          id: 'repay',
          amount: -500,
          date: '2026-07-03',
          user_category: null,
          pfc_primary: 'TRANSFER_IN',
          pfc_detailed: null,
        },
      ],
      ctx({ flight: 500, repay: 500 }),
      months
    )
    expect(flows[0].spending).toBe(0) // June: not a $500 spike
    expect(flows[1].spending).toBe(0) // July: not -$500
    expect(flows[1].income).toBe(0) // and the repayment is not income
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/dashboard.test.ts`
Expected: FAIL — `monthlyFlows` still expects 5 arguments.

- [ ] **Step 3: Change `lib/dashboard.ts`**

Add to the imports at the top:

```ts
import { spendableAmount } from './reimbursements'
import type { SpendContext } from './spend-context'
```

Add `id: string` to the `FlowTxn` type (line 5-11). Then replace `monthlyFlows` (lines 84-115) with:

```ts
export function monthlyFlows(
  txns: FlowTxn[],
  ctx: SpendContext,
  months: { key: string; label: string }[]
): { key: string; label: string; spending: number; income: number }[] {
  const acc: Record<string, { spending: number; income: number }> = {}
  for (const m of months) acc[m.key] = { spending: 0, income: 0 }
  for (const t of txns) {
    const mk = monthKey(t.date)
    const bucket = acc[mk]
    if (!bucket) continue
    // A credit-card payment is an internal transfer — skip both legs (out of checking, into card).
    if (isCreditCardPayment(t)) continue
    const cat = effectiveCategory(t, ctx.pfcMap)
    // Transfers are neither spending nor income.
    if (ctx.transfers.has(cat)) continue
    // Income categories are in nonSpending but not transfers (transfers are already gone).
    const isIncomeCategory = ctx.nonSpending.has(cat)
    // Net of anything reimbursable (#27): a fully-reimbursable outflow contributes 0, and a tagged
    // repayment contributes 0 rather than reading as income or as a refund.
    const amt = spendableAmount(t, ctx.reimbursedByTxn)
    if (amt > 0) {
      // Money out: spending, unless it's an income category (rare; e.g. a clawback).
      if (!isIncomeCategory) bucket.spending += amt
    } else if (amt < 0) {
      // Money in: real income for an income category; otherwise a refund that nets down spending.
      if (isIncomeCategory) bucket.income += -amt
      else bucket.spending += amt
    }
  }
  return months.map((m) => ({ ...m, ...acc[m.key] }))
}
```

Update the comment block above it (lines 75-83) to mention the reimbursable rule alongside the existing refund explanation.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/dashboard.test.ts`
Expected: PASS, including the two new cases.

- [ ] **Step 5: Update the two calling pages**

`app/(app)/dashboard/page.tsx:102` becomes:

```tsx
  const flows = monthlyFlows(withWriteOffs as FlowTxn[], ctx, months)
```

reusing the `ctx` and `withWriteOffs` built in Task 4. `app/(app)/breakdown/[metric]/page.tsx:126` likewise becomes `monthlyFlows(withWriteOffs as FlowTxn[], ctx, months)`. Delete the now-unused `nonSpendingNames` / `transferNames` imports and locals from both pages if nothing else references them.

- [ ] **Step 6: Verify the build and the whole suite**

```bash
npx tsc --noEmit && npx vitest run && npm run lint && npm run build
```

Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add lib/dashboard.ts tests/unit/dashboard.test.ts "app/(app)/dashboard/page.tsx" "app/(app)/breakdown/[metric]/page.tsx"
git commit -m "refactor: route monthlyFlows through SpendContext (#27)"
```

---

### Task 6: Claim totals and the per-person breakdown

**Files:**
- Modify: `lib/reimbursements.ts`
- Modify: `tests/unit/reimbursements.test.ts`

**Interfaces:**
- Consumes: `Split`, `Claim` (Task 2).
- Produces:
  - `type PersonTotal = { owedBy: string; owed: number; returned: number; outstanding: number }`
  - `type ClaimTotals = { owed: number; returned: number; outstanding: number; settled: boolean; writtenOff: boolean; byPerson: PersonTotal[] }`
  - `claimTotals(claim: Claim, splits: Split[], amountById: Record<string, number>): ClaimTotals`

`splits` is only that claim's splits. `amountById` maps transaction id to its signed amount, which is how a split's direction is known: a split on an outflow is money owed to you, a split on an inflow is money returned.

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/reimbursements.test.ts`:

```ts
import { claimTotals, type Claim } from '@/lib/reimbursements'

describe('claimTotals', () => {
  const open: Claim = { id: 'c1', name: 'Vacation rental', written_off_on: null }

  // The scenario from the spec: $1,000 rental, $250 each from three people, Dave has paid.
  const splits: Split[] = [
    { transaction_id: 'rental', claim_id: 'c1', owed_by: 'Dave', amount: 250 },
    { transaction_id: 'rental', claim_id: 'c1', owed_by: 'Sam', amount: 250 },
    { transaction_id: 'rental', claim_id: 'c1', owed_by: 'Priya', amount: 250 },
    { transaction_id: 'dave-repay', claim_id: 'c1', owed_by: 'Dave', amount: 250 },
  ]
  const amountById = { rental: 1000, 'dave-repay': -250 }

  it('splits owed from returned by the sign of the transaction', () => {
    const r = claimTotals(open, splits, amountById)
    expect(r.owed).toBeCloseTo(750)
    expect(r.returned).toBeCloseTo(250)
    expect(r.outstanding).toBeCloseTo(500)
  })

  it('breaks the outstanding amount down per person', () => {
    const r = claimTotals(open, splits, amountById)
    const byName = Object.fromEntries(r.byPerson.map((p) => [p.owedBy, p]))
    expect(byName['Dave'].outstanding).toBeCloseTo(0)
    expect(byName['Sam'].outstanding).toBeCloseTo(250)
    expect(byName['Priya'].outstanding).toBeCloseTo(250)
  })

  it('sorts the biggest outstanding debtor first', () => {
    const r = claimTotals(open, splits, amountById)
    expect(r.byPerson[r.byPerson.length - 1].owedBy).toBe('Dave') // fully paid, so last
  })

  // "Settled" is DERIVED, never stored — there is no status column to drift.
  it('derives settled from the totals, not from a stored field', () => {
    const paid: Split[] = [
      { transaction_id: 'rental', claim_id: 'c1', owed_by: 'Dave', amount: 250 },
      { transaction_id: 'dave-repay', claim_id: 'c1', owed_by: 'Dave', amount: 250 },
    ]
    const r = claimTotals(open, paid, { rental: 1000, 'dave-repay': -250 })
    expect(r.outstanding).toBe(0)
    expect(r.settled).toBe(true)
    expect(r.writtenOff).toBe(false)
  })

  it('is not settled while anything is outstanding', () => {
    expect(claimTotals(open, splits, amountById).settled).toBe(false)
  })

  it('reports a written-off claim as written off', () => {
    const written: Claim = { id: 'c1', name: 'Q3 work travel', written_off_on: '2026-11-03' }
    const r = claimTotals(written, splits, amountById)
    expect(r.writtenOff).toBe(true)
  })

  it('groups splits with no person under Unattributed', () => {
    const r = claimTotals(
      open,
      [{ transaction_id: 'rental', claim_id: 'c1', owed_by: null, amount: 400 }],
      { rental: 500 }
    )
    expect(r.byPerson).toHaveLength(1)
    expect(r.byPerson[0].owedBy).toBe('Unattributed')
    expect(r.byPerson[0].outstanding).toBeCloseTo(400)
  })

  it('is all zeroes for a claim with no splits', () => {
    const r = claimTotals(open, [], {})
    expect(r).toMatchObject({ owed: 0, returned: 0, outstanding: 0, byPerson: [] })
  })

  // A split whose transaction is missing from the map (deleted, or outside the fetched window)
  // must not silently count as a repayment just because its amount reads as 0.
  it('ignores a split whose transaction is unknown', () => {
    const r = claimTotals(
      open,
      [{ transaction_id: 'ghost', claim_id: 'c1', owed_by: 'Dave', amount: 250 }],
      {}
    )
    expect(r.owed).toBe(0)
    expect(r.returned).toBe(0)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/reimbursements.test.ts`
Expected: FAIL — `claimTotals` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `lib/reimbursements.ts`:

```ts
export type PersonTotal = {
  owedBy: string // 'Unattributed' when the split has no owed_by
  owed: number
  returned: number
  outstanding: number
}

export type ClaimTotals = {
  owed: number
  returned: number
  outstanding: number
  settled: boolean // DERIVED from the totals — deliberately not a stored column
  writtenOff: boolean
  byPerson: PersonTotal[] // biggest outstanding first
}

const UNATTRIBUTED = 'Unattributed'

// Totals for ONE claim. `splits` must be that claim's splits; `amountById` maps transaction id to
// its signed amount, which is how a split's direction is read: a split on an outflow is money owed
// to you, a split on an inflow is money that came back.
export function claimTotals(
  claim: Claim,
  splits: Split[],
  amountById: Record<string, number>
): ClaimTotals {
  const people = new Map<string, PersonTotal>()
  let owed = 0
  let returned = 0

  for (const s of splits) {
    const txnAmount = amountById[s.transaction_id]
    // Unknown transaction (deleted, or outside the fetched window): skip rather than guess. Without
    // this, `undefined < 0` is false, so the split would fall through as an EXPENSE and silently
    // inflate what the claim claims it is owed. Must be `=== undefined`, not a falsy check — a
    // transaction legitimately worth 0 has a known direction and should still be processed.
    if (txnAmount === undefined) continue
    const isRepayment = txnAmount < 0

    const key = s.owed_by?.trim() || UNATTRIBUTED
    const p = people.get(key) ?? { owedBy: key, owed: 0, returned: 0, outstanding: 0 }
    if (isRepayment) {
      returned += s.amount
      p.returned += s.amount
    } else {
      owed += s.amount
      p.owed += s.amount
    }
    p.outstanding = p.owed - p.returned
    people.set(key, p)
  }

  const outstanding = owed - returned
  return {
    owed,
    returned,
    outstanding,
    settled: outstanding <= 0,
    writtenOff: claim.written_off_on !== null,
    byPerson: [...people.values()].sort((a, b) => b.outstanding - a.outstanding),
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/reimbursements.test.ts`
Expected: PASS, 20 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/reimbursements.ts tests/unit/reimbursements.test.ts
git commit -m "feat: claim totals with a per-person outstanding breakdown (#27)"
```

---

### Task 7: Write-off allocation

**Files:**
- Modify: `lib/reimbursements.ts`
- Modify: `tests/unit/reimbursements.test.ts`

**Interfaces:**
- Consumes: `Split`, `Claim`, `WriteOff`, `claimTotals` (Tasks 2, 6).
- Produces: `allocateWriteOff(claim: Claim, splits: Split[], categoryById: Record<string, string>, amountById: Record<string, number>, onDate: string): WriteOff[]`

`categoryById` maps transaction id to its **effective category name** — the caller computes it with `effectiveCategory`, so this module stays free of category logic.

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/reimbursements.test.ts`:

```ts
import { allocateWriteOff } from '@/lib/reimbursements'

describe('allocateWriteOff', () => {
  const open: Claim = { id: 'c1', name: 'Bourbon trail trip', written_off_on: null }

  it('writes off the unreturned amount, dated the write-off day', () => {
    const splits: Split[] = [
      { transaction_id: 'dinner', claim_id: 'c1', owed_by: 'Dave', amount: 840 },
      { transaction_id: 'repay', claim_id: 'c1', owed_by: 'Dave', amount: 300 },
    ]
    const r = allocateWriteOff(
      open,
      splits,
      { dinner: 'Food & Drink', repay: 'Transfer In' },
      { dinner: 900, repay: -300 },
      '2026-11-03'
    )
    expect(r).toHaveLength(1)
    expect(r[0].amount).toBeCloseTo(540) // 840 owed - 300 returned
    expect(r[0].category).toBe('Food & Drink')
    expect(r[0].date).toBe('2026-11-03') // NOT the original expense date
    expect(r[0].claim_id).toBe('c1')
  })

  it('allocates pro-rata across the categories the expenses came from', () => {
    const splits: Split[] = [
      { transaction_id: 'hotel', claim_id: 'c1', owed_by: 'Sam', amount: 750 },
      { transaction_id: 'dinner', claim_id: 'c1', owed_by: 'Sam', amount: 250 },
    ]
    const r = allocateWriteOff(
      open,
      splits,
      { hotel: 'Travel', dinner: 'Food & Drink' },
      { hotel: 1000, dinner: 300 },
      '2026-11-03'
    )
    const byCat = Object.fromEntries(r.map((w) => [w.category, w.amount]))
    // $1,000 owed, nothing returned: Travel 75%, Food & Drink 25%.
    expect(byCat['Travel']).toBeCloseTo(750)
    expect(byCat['Food & Drink']).toBeCloseTo(250)
  })

  it('allocates a partial repayment pro-rata too', () => {
    const splits: Split[] = [
      { transaction_id: 'hotel', claim_id: 'c1', owed_by: 'Sam', amount: 750 },
      { transaction_id: 'dinner', claim_id: 'c1', owed_by: 'Sam', amount: 250 },
      { transaction_id: 'repay', claim_id: 'c1', owed_by: 'Sam', amount: 400 },
    ]
    const r = allocateWriteOff(
      open,
      splits,
      { hotel: 'Travel', dinner: 'Food & Drink', repay: 'Transfer In' },
      { hotel: 1000, dinner: 300, repay: -400 },
      '2026-11-03'
    )
    const byCat = Object.fromEntries(r.map((w) => [w.category, w.amount]))
    // $600 unreturned, split 75/25.
    expect(byCat['Travel']).toBeCloseTo(450)
    expect(byCat['Food & Drink']).toBeCloseTo(150)
    expect(r.reduce((s, w) => s + w.amount, 0)).toBeCloseTo(600)
  })

  it('merges two expenses in the same category into one row', () => {
    const splits: Split[] = [
      { transaction_id: 'lunch', claim_id: 'c1', owed_by: 'Sam', amount: 100 },
      { transaction_id: 'dinner', claim_id: 'c1', owed_by: 'Sam', amount: 300 },
    ]
    const r = allocateWriteOff(
      open,
      splits,
      { lunch: 'Food & Drink', dinner: 'Food & Drink' },
      { lunch: 120, dinner: 350 },
      '2026-11-03'
    )
    expect(r).toHaveLength(1)
    expect(r[0].amount).toBeCloseTo(400)
  })

  it('writes off nothing for a fully repaid claim', () => {
    const splits: Split[] = [
      { transaction_id: 'dinner', claim_id: 'c1', owed_by: 'Dave', amount: 250 },
      { transaction_id: 'repay', claim_id: 'c1', owed_by: 'Dave', amount: 250 },
    ]
    expect(
      allocateWriteOff(
        open,
        splits,
        { dinner: 'Food & Drink', repay: 'Transfer In' },
        { dinner: 300, repay: -250 },
        '2026-11-03'
      )
    ).toEqual([])
  })

  it('writes off nothing for a claim with no splits', () => {
    expect(allocateWriteOff(open, [], {}, {}, '2026-11-03')).toEqual([])
  })

  // Rounding must not lose or invent a cent: three equal shares of $100.01 do not divide evenly, so
  // this pins the residual-cent behaviour. The rows must sum to the outstanding amount EXACTLY.
  it('makes the rows sum to the outstanding amount despite rounding', () => {
    const splits: Split[] = [
      { transaction_id: 'a', claim_id: 'c1', owed_by: null, amount: 100 },
      { transaction_id: 'b', claim_id: 'c1', owed_by: null, amount: 100 },
      { transaction_id: 'c', claim_id: 'c1', owed_by: null, amount: 100 },
      // $199.99 came back, leaving $100.01 outstanding across three equal categories.
      { transaction_id: 'repay', claim_id: 'c1', owed_by: null, amount: 199.99 },
    ]
    const r = allocateWriteOff(
      open,
      splits,
      { a: 'Travel', b: 'Food & Drink', c: 'Entertainment', repay: 'Transfer In' },
      { a: 100, b: 100, c: 100, repay: -199.99 },
      '2026-11-03'
    )
    expect(r).toHaveLength(3)
    // 33.34 + 33.34 + 33.33 — the last row absorbs the residual cent.
    expect(r.reduce((s, w) => s + w.amount, 0)).toBeCloseTo(100.01, 2)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/reimbursements.test.ts`
Expected: FAIL — `allocateWriteOff` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `lib/reimbursements.ts`:

```ts
// Freeze a claim's unreturned amount into spending rows, dated the day the user gave up.
// Allocated pro-rata across the categories the expenses came from, so budgets and the per-category
// breakdown stay coherent for a claim that spanned Travel and Food & Drink.
// FROZEN, not derived: if this were recomputed on read, later editing a split would rewrite a month
// that had already closed — the retroactive rewrite the design explicitly rules out.
export function allocateWriteOff(
  claim: Claim,
  splits: Split[],
  categoryById: Record<string, string>,
  amountById: Record<string, number>,
  onDate: string
): WriteOff[] {
  const { owed, outstanding } = claimTotals(claim, splits, amountById)
  if (outstanding <= 0 || owed <= 0) return []

  // Owed per category, from the expense splits only (repayments carry the payer's category, which
  // has nothing to do with what was bought).
  const owedByCategory = new Map<string, number>()
  for (const s of splits) {
    const txnAmount = amountById[s.transaction_id]
    if (txnAmount === undefined || txnAmount < 0) continue // unknown, or a repayment
    const cat = categoryById[s.transaction_id]
    if (!cat) continue
    owedByCategory.set(cat, (owedByCategory.get(cat) ?? 0) + s.amount)
  }
  if (owedByCategory.size === 0) return []

  const cats = [...owedByCategory.entries()]
  const rows: WriteOff[] = []
  let allocated = 0
  cats.forEach(([category, catOwed], i) => {
    const isLast = i === cats.length - 1
    // The last row takes the remainder so the rows sum EXACTLY to `outstanding` — rounding each
    // share independently would lose or invent a cent.
    const amount = isLast
      ? round2(outstanding - allocated)
      : round2((catOwed / owed) * outstanding)
    allocated += amount
    rows.push({ claim_id: claim.id, category, amount, date: onDate })
  })
  return rows
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/reimbursements.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/reimbursements.ts tests/unit/reimbursements.test.ts
git commit -m "feat: pro-rata write-off allocation, frozen at write-off time (#27)"
```

---

### Task 8: The reconciliation property test

This is the test that catches what per-function tests cannot. Every individual function can look correct while money leaks between them — that is exactly how the refund bug (#8) and the credit-card double-count (#31) survived.

**Files:**
- Create: `tests/unit/reimbursement-reconciliation.test.ts`

**Interfaces:**
- Consumes: `spendByCategory` (Task 4), `monthlyFlows` (Task 5), `buildSpendContext` (Task 3), `writeOffsAsTxns` (Task 2).
- Produces: nothing.

- [ ] **Step 1: Write the test**

```ts
import { describe, it, expect } from 'vitest'
import { spendByCategory, type Txn } from '@/lib/budget'
import { monthlyFlows, type FlowTxn } from '@/lib/dashboard'
import { buildSpendContext } from '@/lib/spend-context'
import { writeOffsAsTxns, type Split, type WriteOff } from '@/lib/reimbursements'
import type { Category } from '@/lib/categories'

const categories: Category[] = [
  { id: '1', name: 'Income', pfc_primary: 'INCOME', sort_order: 0 },
  { id: '2', name: 'Transfer In', pfc_primary: 'TRANSFER_IN', sort_order: 1 },
  { id: '3', name: 'Travel', pfc_primary: 'TRAVEL', sort_order: 2 },
  { id: '4', name: 'Food & Drink', pfc_primary: 'FOOD_AND_DRINK', sort_order: 3 },
]

// One month, deliberately containing every interesting shape at once.
const txns: Txn[] = [
  // plain spending
  { id: 'a', amount: 120, date: '2026-07-02', user_category: null, pfc_primary: 'FOOD_AND_DRINK', pfc_detailed: null },
  // partly reimbursable: $500 dinner, $400 back from work
  { id: 'b', amount: 500, date: '2026-07-04', user_category: null, pfc_primary: 'FOOD_AND_DRINK', pfc_detailed: null },
  // fully reimbursable outflow
  { id: 'c', amount: 300, date: '2026-07-06', user_category: null, pfc_primary: 'TRAVEL', pfc_detailed: null },
  // a genuine refund, NOT reimbursable — must still net down Travel
  { id: 'd', amount: -50, date: '2026-07-08', user_category: null, pfc_primary: 'TRAVEL', pfc_detailed: null },
  // a tagged repayment, deliberately in a SPENDING category: untagged it would net Travel down by
  // 400 like a refund, so this is what proves tagging makes it flow-neutral
  { id: 'e', amount: -400, date: '2026-07-10', user_category: null, pfc_primary: 'TRAVEL', pfc_detailed: null },
  // real income
  { id: 'f', amount: -2000, date: '2026-07-12', user_category: null, pfc_primary: 'INCOME', pfc_detailed: null },
  // a credit-card payment, excluded from both sides
  { id: 'g', amount: 900, date: '2026-07-14', user_category: null, pfc_primary: 'LOAN_PAYMENTS', pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' },
]

const splits: Split[] = [
  { transaction_id: 'b', claim_id: 'c1', owed_by: 'Employer', amount: 400 },
  { transaction_id: 'c', claim_id: 'c1', owed_by: 'Employer', amount: 300 },
  { transaction_id: 'e', claim_id: 'c1', owed_by: 'Employer', amount: 400 },
]

const writeOffs: WriteOff[] = [
  { claim_id: 'c2', category: 'Travel', amount: 75, date: '2026-07-20' },
]

describe('reimbursement reconciliation', () => {
  const ctx = buildSpendContext({ categories, splits })
  const all = [...txns, ...writeOffsAsTxns(writeOffs)]

  // total spending == Σ outflows − Σ reimbursable splits + Σ write-offs, with refunds still netting.
  it('spendByCategory totals reconcile with the inputs', () => {
    const total = Object.values(spendByCategory(all, ctx)).reduce((s, v) => s + v, 0)
    // outflows that count: 120 + 500 + 300 = 920 (the card payment is excluded)
    // reimbursable on those outflows: 400 + 300 = 700
    // the untagged refund still nets down: -50
    // the tagged repayment (e) contributes 0 — NOT -400
    // the write-off adds: +75
    expect(total).toBeCloseTo(920 - 700 - 50 + 75) // 245
  })

  it('monthlyFlows agrees with spendByCategory on spending for the month', () => {
    const flows = monthlyFlows(all as FlowTxn[], ctx, [{ key: '2026-07', label: 'Jul' }])
    const fromCategories = Object.values(spendByCategory(all, ctx)).reduce((s, v) => s + v, 0)
    expect(flows[0].spending).toBeCloseTo(fromCategories)
  })

  it('counts real income but not the tagged repayment', () => {
    const flows = monthlyFlows(all as FlowTxn[], ctx, [{ key: '2026-07', label: 'Jul' }])
    expect(flows[0].income).toBeCloseTo(2000)
  })

  // With no splits and no write-offs, every number must match the pre-#27 behaviour exactly: both
  // inflows in spending categories net down like refunds, which is the #8 behaviour we must preserve.
  it('is a no-op when nothing is reimbursable', () => {
    const plain = buildSpendContext({ categories, splits: [] })
    const total = Object.values(spendByCategory(txns, plain)).reduce((s, v) => s + v, 0)
    expect(total).toBeCloseTo(920 - 50 - 400) // 470 — e now nets Travel down, as a refund would
    const flows = monthlyFlows(txns as FlowTxn[], plain, [{ key: '2026-07', label: 'Jul' }])
    expect(flows[0].spending).toBeCloseTo(470)
    expect(flows[0].income).toBeCloseTo(2000)
  })
})
```

The contrast between the two totals — **245 tagged versus 470 untagged** — is the feature in one number. If both come out the same, `spendableAmount` is not being reached.

- [ ] **Step 2: Run it**

Run: `npx vitest run tests/unit/reimbursement-reconciliation.test.ts`

Expected: PASS, 4 tests.

If anything fails, work out on paper what each of the seven transactions should contribute, then compare. **Fix the code to match the reasoning, not the expectation to match the output** — this test exists precisely to catch a function that is wrong, and an expectation edited to make it green destroys its whole purpose.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/reimbursement-reconciliation.test.ts
git commit -m "test: reconciliation property across spending, flows and write-offs (#27)"
```

---

### Task 9: Claims API

**Files:**
- Create: `app/api/reimbursements/claims/route.ts`

**Interfaces:**
- Consumes: `claimTotals`, `allocateWriteOff`, types (Tasks 2, 6, 7); `effectiveCategory`, `pfcToName`.
- Produces: `GET` (claims with totals), `POST` (create, returns `{ id }`), `PATCH` (rename), `DELETE`. Write-off is `POST /api/reimbursements/claims` with `{ action: 'write_off', id }`.

Follow the household-resolution pattern in `app/api/categories/route.ts:4-11` exactly.

- [ ] **Step 1: Write the route**

```ts
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { pfcToName, type Category } from '@/lib/categories'
import { effectiveCategory } from '@/lib/effective-category'
import {
  claimTotals,
  allocateWriteOff,
  type Claim,
  type Split,
} from '@/lib/reimbursements'

async function household(supabase: Awaited<ReturnType<typeof createClient>>) {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return null
  const { data: m } = await supabase.from('memberships').select('household_id').limit(1).single()
  return m?.household_id ?? null
}

// Every claim with its totals and per-person breakdown. RLS scopes all three reads to the household.
export async function GET() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: claims } = await supabase
    .from('reimbursement_claims')
    .select('id, name, written_off_on')
    .order('created_at', { ascending: false })
  const { data: splits } = await supabase
    .from('reimbursement_splits')
    .select('transaction_id, claim_id, owed_by, amount')
  const { data: txns } = await supabase.from('transactions').select('id, amount, date')

  const amountById: Record<string, number> = {}
  for (const t of txns ?? []) amountById[t.id as string] = Number(t.amount)

  const all = (splits ?? []) as Split[]
  const withTotals = ((claims ?? []) as Claim[]).map((c) => ({
    ...c,
    totals: claimTotals(
      c,
      all.filter((s) => s.claim_id === c.id),
      amountById
    ),
  }))
  return NextResponse.json({ claims: withTotals })
}

// Create a claim (called inline the first time a name is typed in the split editor), or write one
// off. Both are POST so the split editor can create-and-use in a single round trip.
export async function POST(req: Request) {
  const body = await req.json()
  const supabase = await createClient()
  const hid = await household(supabase)
  if (!hid) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  if (body.action === 'write_off') {
    return writeOff(supabase, hid, body.id, body.onDate)
  }

  const name = (body.name ?? '').trim()
  if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 })

  // Idempotent on name: typing an existing claim's name in the editor reuses it rather than failing
  // on the unique constraint.
  const { data: existing } = await supabase
    .from('reimbursement_claims')
    .select('id')
    .eq('name', name)
    .maybeSingle()
  if (existing) return NextResponse.json({ id: existing.id })

  const { data, error } = await supabase
    .from('reimbursement_claims')
    .insert({ household_id: hid, name })
    .select('id')
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 400 })
  return NextResponse.json({ id: data.id })
}

// Giving up on a claim turns the unreturned amount into real spending, dated TODAY (not the original
// expense month — no closed month may change), allocated pro-rata across the categories it came from
// and then frozen as rows.
async function writeOff(
  supabase: Awaited<ReturnType<typeof createClient>>,
  hid: string,
  id: string,
  onDate?: string
) {
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  const { data: claim } = await supabase
    .from('reimbursement_claims')
    .select('id, name, written_off_on')
    .eq('id', id)
    .single()
  if (!claim) return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (claim.written_off_on) {
    return NextResponse.json({ error: 'already written off' }, { status: 400 })
  }

  const { data: splits } = await supabase
    .from('reimbursement_splits')
    .select('transaction_id, claim_id, owed_by, amount')
    .eq('claim_id', id)
  const { data: cats } = await supabase
    .from('categories')
    .select('id, name, pfc_primary, sort_order')
  const pfcMap = pfcToName((cats ?? []) as Category[])

  const ids = [...new Set(((splits ?? []) as Split[]).map((s) => s.transaction_id))]
  const { data: txns } = await supabase
    .from('transactions')
    .select('id, amount, user_category, pfc_primary')
    .in('id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000'])

  const amountById: Record<string, number> = {}
  const categoryById: Record<string, string> = {}
  for (const t of txns ?? []) {
    amountById[t.id as string] = Number(t.amount)
    categoryById[t.id as string] = effectiveCategory(
      { user_category: t.user_category as string | null, pfc_primary: t.pfc_primary as string | null },
      pfcMap
    )
  }

  const date = onDate ?? new Date().toISOString().slice(0, 10)
  const rows = allocateWriteOff(
    claim as Claim,
    (splits ?? []) as Split[],
    categoryById,
    amountById,
    date
  )

  if (rows.length) {
    const { error } = await supabase
      .from('reimbursement_write_offs')
      .insert(rows.map((r) => ({ ...r, household_id: hid })))
    if (error) return NextResponse.json({ error: error.message }, { status: 400 })
  }
  const { error: markError } = await supabase
    .from('reimbursement_claims')
    .update({ written_off_on: date })
    .eq('id', id)
  if (markError) return NextResponse.json({ error: markError.message }, { status: 400 })

  return NextResponse.json({ ok: true, written: rows })
}

export async function PATCH(req: Request) {
  const { id, name } = await req.json()
  const clean = (name ?? '').trim()
  if (!id || !clean) return NextResponse.json({ error: 'id and name required' }, { status: 400 })
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const { error } = await supabase
    .from('reimbursement_claims')
    .update({ name: clean })
    .eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 400 })
  return NextResponse.json({ ok: true })
}

// Deleting a claim cascades its splits (FK), so the money it was excluding returns to spending.
// The UI guards this with ConfirmDialog.
export async function DELETE(req: Request) {
  const { id } = await req.json()
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const { error } = await supabase.from('reimbursement_claims').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 400 })
  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 2: Verify it compiles**

```bash
npx tsc --noEmit && npm run lint
```

Expected: clean.

- [ ] **Step 3: Smoke-test against the running app**

```bash
npm run dev
```

Signed in, in the browser console:

```js
await (await fetch('/api/reimbursements/claims', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'Bourbon trail trip' }),
})).json()
// -> { id: '...' }
await (await fetch('/api/reimbursements/claims')).json()
// -> { claims: [{ name: 'Bourbon trail trip', totals: { owed: 0, ... } }] }
```

Then POST the same name again and confirm it returns the **same** id rather than an error.

- [ ] **Step 4: Commit**

```bash
git add app/api/reimbursements/claims/route.ts
git commit -m "feat: claims API with inline create and pro-rata write-off (#27)"
```

---

### Task 10: Splits API with cross-row validation

**Files:**
- Create: `app/api/reimbursements/splits/route.ts`
- Create: `lib/split-validation.ts`
- Test: `tests/unit/split-validation.test.ts`

**Interfaces:**
- Consumes: `Split`, `claimTotals` (Tasks 2, 6).
- Produces:
  - `validateSplit(input: { txnAmount: number; existingOnTxn: number; proposed: number; isRepayment: boolean; claimOutstanding: number }): { ok: true } | { ok: false; error: string }`
  - `POST` (add a split), `DELETE` (remove one) on `/api/reimbursements/splits`.

The rule cannot live in a `check` constraint: a per-row constraint cannot see sibling rows, so the cross-row sum is validated server-side. Extracting it into a pure function is what makes it testable.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/split-validation.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { validateSplit } from '@/lib/split-validation'

describe('validateSplit', () => {
  it('accepts a split within the transaction amount', () => {
    expect(
      validateSplit({
        txnAmount: 1000,
        existingOnTxn: 500,
        proposed: 250,
        isRepayment: false,
        claimOutstanding: 0,
      })
    ).toEqual({ ok: true })
  })

  it('accepts splits that exactly consume the transaction', () => {
    expect(
      validateSplit({
        txnAmount: 500,
        existingOnTxn: 100,
        proposed: 400,
        isRepayment: false,
        claimOutstanding: 0,
      }).ok
    ).toBe(true)
  })

  it('rejects splits totalling more than the transaction', () => {
    const r = validateSplit({
      txnAmount: 1000,
      existingOnTxn: 800,
      proposed: 250,
      isRepayment: false,
      claimOutstanding: 0,
    })
    expect(r.ok).toBe(false)
  })

  it('rejects a zero or negative amount', () => {
    expect(
      validateSplit({ txnAmount: 1000, existingOnTxn: 0, proposed: 0, isRepayment: false, claimOutstanding: 0 }).ok
    ).toBe(false)
    expect(
      validateSplit({ txnAmount: 1000, existingOnTxn: 0, proposed: -50, isRepayment: false, claimOutstanding: 0 }).ok
    ).toBe(false)
  })

  // Dave rounds $250 up to $260: he may tag at most the $250 outstanding, and the surplus is left
  // untagged so it behaves as any untagged inflow of that category would.
  it('rejects a repayment split above the claim outstanding', () => {
    const r = validateSplit({
      txnAmount: -260,
      existingOnTxn: 0,
      proposed: 260,
      isRepayment: true,
      claimOutstanding: 250,
    })
    expect(r.ok).toBe(false)
  })

  it('accepts a repayment split up to the claim outstanding', () => {
    expect(
      validateSplit({
        txnAmount: -260,
        existingOnTxn: 0,
        proposed: 250,
        isRepayment: true,
        claimOutstanding: 250,
      }).ok
    ).toBe(true)
  })

  // The transaction-amount ceiling uses the ABSOLUTE value, since inflows are negative.
  it('measures an inflow against its absolute amount', () => {
    expect(
      validateSplit({
        txnAmount: -250,
        existingOnTxn: 0,
        proposed: 300,
        isRepayment: true,
        claimOutstanding: 9999,
      }).ok
    ).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/split-validation.test.ts`
Expected: FAIL — cannot resolve `@/lib/split-validation`.

- [ ] **Step 3: Write the implementation**

Create `lib/split-validation.ts`:

```ts
// Splits are constrained across ROWS: their total may not exceed the transaction, and a repayment
// may not exceed what the claim is still owed. A per-row `check` constraint cannot see siblings, so
// this runs server-side on every write. Pure, so it is testable without a database.

export type SplitValidation = { ok: true } | { ok: false; error: string }

export function validateSplit(input: {
  txnAmount: number // signed: > 0 money out, < 0 money in
  existingOnTxn: number // splits already on this transaction
  proposed: number // the new split amount
  isRepayment: boolean // derived from txnAmount < 0
  claimOutstanding: number // what the claim is still owed, before this split
}): SplitValidation {
  const { txnAmount, existingOnTxn, proposed, isRepayment, claimOutstanding } = input

  if (!(proposed > 0)) {
    return { ok: false, error: 'Split amount must be greater than zero.' }
  }

  const ceiling = Math.abs(txnAmount)
  if (existingOnTxn + proposed > ceiling + 0.001) {
    const room = Math.max(0, ceiling - existingOnTxn)
    return {
      ok: false,
      error: `Splits can't exceed the transaction. At most ${room.toFixed(2)} is left to assign.`,
    }
  }

  if (isRepayment && proposed > claimOutstanding + 0.001) {
    return {
      ok: false,
      error: `That's more than this claim is owed. At most ${claimOutstanding.toFixed(2)} can be applied; leave the rest untagged.`,
    }
  }

  return { ok: true }
}
```

The `0.001` tolerances absorb floating-point noise from `numeric` round-tripping, so splitting $1,000 into three $333.34/$333.33/$333.33 parts is not rejected by a sub-cent artefact.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/split-validation.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Write the route**

Create `app/api/reimbursements/splits/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { claimTotals, type Claim, type Split } from '@/lib/reimbursements'
import { validateSplit } from '@/lib/split-validation'

async function household(supabase: Awaited<ReturnType<typeof createClient>>) {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return null
  const { data: m } = await supabase.from('memberships').select('household_id').limit(1).single()
  return m?.household_id ?? null
}

export async function POST(req: Request) {
  const { transactionId, claimId, owedBy, amount } = await req.json()
  if (!transactionId || !claimId) {
    return NextResponse.json({ error: 'transactionId and claimId required' }, { status: 400 })
  }
  const proposed = Number(amount)
  if (!Number.isFinite(proposed)) {
    return NextResponse.json({ error: 'amount must be a number' }, { status: 400 })
  }

  const supabase = await createClient()
  const hid = await household(supabase)
  if (!hid) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: txn } = await supabase
    .from('transactions')
    .select('id, amount')
    .eq('id', transactionId)
    .maybeSingle()
  if (!txn) return NextResponse.json({ error: 'transaction not found' }, { status: 404 })

  const { data: claim } = await supabase
    .from('reimbursement_claims')
    .select('id, name, written_off_on')
    .eq('id', claimId)
    .maybeSingle()
  if (!claim) return NextResponse.json({ error: 'claim not found' }, { status: 404 })
  // A written-off claim is closed for good: money arriving later is ordinary income, not a repayment.
  if (claim.written_off_on) {
    return NextResponse.json({ error: 'that claim is written off' }, { status: 400 })
  }

  const { data: onTxn } = await supabase
    .from('reimbursement_splits')
    .select('amount')
    .eq('transaction_id', transactionId)
  const existingOnTxn = (onTxn ?? []).reduce((s, r) => s + Number(r.amount), 0)

  // The claim's outstanding, needed to cap a repayment. Fetch this claim's splits and their txns.
  const { data: claimSplits } = await supabase
    .from('reimbursement_splits')
    .select('transaction_id, claim_id, owed_by, amount')
    .eq('claim_id', claimId)
  const ids = [...new Set(((claimSplits ?? []) as Split[]).map((s) => s.transaction_id))]
  const { data: claimTxns } = await supabase
    .from('transactions')
    .select('id, amount')
    .in('id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000'])
  const amountById: Record<string, number> = {}
  for (const t of claimTxns ?? []) amountById[t.id as string] = Number(t.amount)
  const { outstanding } = claimTotals(
    claim as Claim,
    (claimSplits ?? []) as Split[],
    amountById
  )

  const txnAmount = Number(txn.amount)
  const check = validateSplit({
    txnAmount,
    existingOnTxn,
    proposed,
    isRepayment: txnAmount < 0,
    claimOutstanding: outstanding,
  })
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 })

  const { error } = await supabase.from('reimbursement_splits').insert({
    household_id: hid,
    transaction_id: transactionId,
    claim_id: claimId,
    owed_by: (owedBy ?? '').trim() || null,
    amount: proposed,
  })
  if (error) return NextResponse.json({ error: error.message }, { status: 400 })
  return NextResponse.json({ ok: true })
}

export async function DELETE(req: Request) {
  const { id } = await req.json()
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const { error } = await supabase.from('reimbursement_splits').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 400 })
  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 6: Verify and smoke-test**

```bash
npx tsc --noEmit && npx vitest run && npm run lint
```

With `npm run dev` running, take a real transaction id from the Transactions page and POST a split larger than the transaction; confirm a 400 with the "Splits can't exceed the transaction" message.

- [ ] **Step 7: Commit**

```bash
git add lib/split-validation.ts tests/unit/split-validation.test.ts app/api/reimbursements/splits/route.ts
git commit -m "feat: splits API with cross-row and outstanding validation (#27)"
```

---

### Task 11: The split editor

**Files:**
- Create: `components/SplitEditor.tsx`

**Interfaces:**
- Consumes: the two API routes (Tasks 9, 10).
- Produces: `<SplitEditor transactionId amount existingSplits claims onClose />` where
  `existingSplits: { id: string; claim_id: string; owed_by: string | null; amount: number }[]`
  and `claims: { id: string; name: string }[]`.

Follow the client-component pattern in `components/CategoryPicker.tsx`: `'use client'`, local state, `fetch`, then `router.refresh()`.

- [ ] **Step 1: Write the component**

```tsx
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { money } from '@/lib/format'
import { inputClass, selectClass } from './ui/styles'
import { Button } from './ui/Button'

type ExistingSplit = { id: string; claim_id: string; owed_by: string | null; amount: number }

export function SplitEditor({
  transactionId,
  amount,
  existingSplits,
  claims,
  knownPeople,
}: {
  transactionId: string
  amount: number // signed, Plaid convention
  existingSplits: ExistingSplit[]
  claims: { id: string; name: string }[]
  knownPeople: string[]
}) {
  const router = useRouter()
  const [claimName, setClaimName] = useState(
    claims.find((c) => c.id === existingSplits[0]?.claim_id)?.name ?? ''
  )
  const [owedBy, setOwedBy] = useState('')
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const isRepayment = amount < 0
  const assigned = existingSplits.reduce((s, x) => s + x.amount, 0)
  // The live readout: for an outflow this is what actually hits your budget; for a repayment it is
  // the part that stays ordinary income.
  const remainder = Math.max(0, Math.abs(amount) - assigned)

  async function add() {
    setError(null)
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setError('Enter an amount greater than zero.')
      return
    }
    if (!claimName.trim()) {
      setError('Name what this is for.')
      return
    }
    setBusy(true)
    try {
      // Create-or-reuse the claim, then attach the split. The claims route is idempotent on name.
      const claimRes = await fetch('/api/reimbursements/claims', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: claimName.trim() }),
      })
      const claim = await claimRes.json()
      if (!claimRes.ok) {
        setError(claim.error ?? 'Could not save that claim.')
        return
      }
      const res = await fetch('/api/reimbursements/splits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transactionId,
          claimId: claim.id,
          owedBy: owedBy.trim() || null,
          amount: parsed,
        }),
      })
      const body = await res.json()
      if (!res.ok) {
        setError(body.error ?? 'Could not save that split.')
        return
      }
      setOwedBy('')
      setValue('')
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  async function remove(id: string) {
    setBusy(true)
    try {
      await fetch('/api/reimbursements/splits', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      })
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3 rounded-lg bg-surface-2 p-4 text-sm">
      <div>
        <label htmlFor={`claim-${transactionId}`} className="block text-xs text-faint">
          What's this for?
        </label>
        <input
          id={`claim-${transactionId}`}
          list={`claims-${transactionId}`}
          value={claimName}
          onChange={(e) => setClaimName(e.target.value)}
          placeholder="e.g. Bourbon trail trip"
          className={inputClass}
        />
        <datalist id={`claims-${transactionId}`}>
          {claims.map((c) => (
            <option key={c.id} value={c.name} />
          ))}
        </datalist>
      </div>

      {existingSplits.length > 0 && (
        <ul className="space-y-1">
          {existingSplits.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-2">
              <span className="text-ink">{s.owed_by ?? 'Unattributed'}</span>
              <span className="flex items-center gap-2">
                <span className="tabular-nums text-muted">{money(s.amount)}</span>
                <button
                  type="button"
                  onClick={() => remove(s.id)}
                  disabled={busy}
                  aria-label={`Remove ${s.owed_by ?? 'unattributed'} split`}
                  className="text-faint hover:text-ink"
                >
                  ✕
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <div>
          <label htmlFor={`who-${transactionId}`} className="block text-xs text-faint">
            {isRepayment ? 'Who paid you' : 'Who owes you'}
          </label>
          <input
            id={`who-${transactionId}`}
            list={`people-${transactionId}`}
            value={owedBy}
            onChange={(e) => setOwedBy(e.target.value)}
            placeholder="e.g. Dave"
            className={inputClass}
          />
          <datalist id={`people-${transactionId}`}>
            {knownPeople.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
        </div>
        <div>
          <label htmlFor={`amt-${transactionId}`} className="block text-xs text-faint">
            Amount
          </label>
          <input
            id={`amt-${transactionId}`}
            value={value}
            inputMode="decimal"
            onChange={(e) => setValue(e.target.value)}
            placeholder="250.00"
            className={inputClass}
          />
        </div>
        <Button type="button" variant="secondary" onClick={add} disabled={busy}>
          {isRepayment ? 'Apply' : 'Add'}
        </Button>
      </div>

      {error && (
        <p role="alert" className="text-xs text-rose-600">
          {error}
        </p>
      )}

      <p className="text-xs text-faint">
        {isRepayment
          ? `Untagged (counts normally): ${money(remainder)}`
          : `Your share: ${money(remainder)}`}
      </p>
    </div>
  )
}
```

- [ ] **Step 2: Verify it compiles and lints**

```bash
npx tsc --noEmit && npm run lint
```

Expected: clean. If `inputClass` / `selectClass` names differ, check `components/ui/styles.ts` and use what is there. Drop the `selectClass` import if it goes unused.

- [ ] **Step 3: Commit**

```bash
git add components/SplitEditor.tsx
git commit -m "feat: inline split editor with a live your-share readout (#27)"
```

---

### Task 12: Wire the editor into the transactions list

**Files:**
- Modify: `components/TransactionRow.tsx`
- Modify: `app/(app)/transactions/page.tsx`

**Interfaces:**
- Consumes: `SplitEditor` (Task 11).
- Produces: `TransactionRow` gains `splits`, `claims`, `knownPeople` props.

`TransactionRow` is currently a server component. Adding open/close state makes it a client component, matching how `CategoryPicker` already works inside it.

- [ ] **Step 1: Update `TransactionRow`**

Replace `components/TransactionRow.tsx` with:

```tsx
'use client'

import { useState } from 'react'
import { money } from '@/lib/format'
import { CategoryPicker } from './CategoryPicker'
import { SplitEditor } from './SplitEditor'

type Txn = {
  id: string
  date: string
  name: string | null
  merchant_name: string | null
  amount: number
}

type ExistingSplit = { id: string; claim_id: string; owed_by: string | null; amount: number }

export function TransactionRow({
  t,
  categoryName,
  categoryOptions,
  splits,
  claims,
  knownPeople,
}: {
  t: Txn
  categoryName: string
  categoryOptions: string[]
  splits: ExistingSplit[]
  claims: { id: string; name: string }[]
  knownPeople: string[]
}) {
  const [open, setOpen] = useState(false)
  // Plaid: amount > 0 means money OUT. Show spending as negative.
  const display = -t.amount
  const assigned = splits.reduce((s, x) => s + x.amount, 0)
  // What this row actually contributes once reimbursables are removed — shown alongside the real
  // bank amount so the row still reconciles with the statement.
  const share = Math.max(0, Math.abs(t.amount) - assigned)
  const label = t.merchant_name ?? t.name

  return (
    <>
      <tr className="border-b border-line transition-colors hover:bg-surface-2">
        <td className="px-4 py-3 whitespace-nowrap text-sm text-muted">{t.date}</td>
        <td className="px-4 py-3 font-medium text-ink">{label}</td>
        <td className="px-4 py-3">
          <CategoryPicker
            transactionId={t.id}
            value={categoryName}
            options={categoryOptions}
            label={label ?? undefined}
          />
        </td>
        <td
          className={`px-4 py-3 text-right font-medium tabular-nums ${display < 0 ? 'text-ink' : 'text-emerald'}`}
        >
          {money(display)}
          {assigned > 0 && (
            <span className="block text-xs font-normal text-faint">
              {/* An outflow's share is money out (shown negative); an inflow's untagged remainder is
                  money in (shown positive) — matching the `display` convention above. */}
              your share {money(t.amount < 0 ? share : -share)}
            </span>
          )}
        </td>
        <td className="px-4 py-3 text-right">
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-label={`Split ${label ?? 'transaction'}`}
            className="text-xs font-medium text-emerald hover:text-emerald-600"
          >
            {assigned > 0 ? 'Splits' : 'Split'}
          </button>
        </td>
      </tr>
      {open && (
        <tr className="border-b border-line">
          <td colSpan={5} className="px-4 pb-4">
            <SplitEditor
              transactionId={t.id}
              amount={t.amount}
              existingSplits={splits}
              claims={claims}
              knownPeople={knownPeople}
            />
          </td>
        </tr>
      )}
    </>
  )
}
```

- [ ] **Step 2: Update the transactions page**

In `app/(app)/transactions/page.tsx`, after the categories query, add:

```tsx
  const { data: claimRows } = await supabase
    .from('reimbursement_claims')
    .select('id, name')
    .is('written_off_on', null)
    .order('created_at', { ascending: false })
  const claims = (claimRows ?? []) as { id: string; name: string }[]

  const { data: splitRows } = await supabase
    .from('reimbursement_splits')
    .select('id, transaction_id, claim_id, owed_by, amount')
  const splitsByTxn: Record<string, { id: string; claim_id: string; owed_by: string | null; amount: number }[]> = {}
  for (const s of splitRows ?? []) {
    const key = s.transaction_id as string
    ;(splitsByTxn[key] ??= []).push({
      id: s.id as string,
      claim_id: s.claim_id as string,
      owed_by: s.owed_by as string | null,
      amount: Number(s.amount),
    })
  }
  // Autocomplete for the person field, so "Dave" stays one person instead of fragmenting.
  const knownPeople = [
    ...new Set((splitRows ?? []).map((s) => (s.owed_by as string | null)?.trim()).filter(Boolean)),
  ] as string[]
```

Add the header cell for the new column, after the Amount `<th>` (around line 198):

```tsx
                  <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wide text-faint">
                    <span className="sr-only">Split</span>
                  </th>
```

And pass the new props at the `TransactionRow` call (line 204-211):

```tsx
                  <TransactionRow
                    key={t.id}
                    t={t}
                    categoryName={effectiveCategory(t, pfcMap)}
                    categoryOptions={categoryOptions}
                    splits={splitsByTxn[t.id] ?? []}
                    claims={claims}
                    knownPeople={knownPeople}
                  />
```

- [ ] **Step 3: Verify**

```bash
npx tsc --noEmit && npx vitest run && npm run lint && npm run build
```

Expected: all green.

- [ ] **Step 4: Manual check**

With `npm run dev`, open `/transactions`, click **Split** on an outflow, add two people, and confirm the "Your share" readout drops live and the row shows a "your share" sub-line. Then check `/budgets` reflects the reduced amount.

- [ ] **Step 5: Commit**

```bash
git add components/TransactionRow.tsx "app/(app)/transactions/page.tsx"
git commit -m "feat: split a transaction from the transactions list (#27)"
```

---

### Task 13: The Reimbursements page

**Files:**
- Create: `components/ClaimList.tsx`
- Create: `app/(app)/reimbursements/page.tsx`
- Modify: `components/AppShell.tsx:24-29`
- Modify: `components/ui/icons.tsx`

**Interfaces:**
- Consumes: `claimTotals`, `ClaimTotals` (Task 6); the claims API (Task 9); `ConfirmDialog`.
- Produces: the `/reimbursements` route.

- [ ] **Step 1: Add the nav icon**

Append to `components/ui/icons.tsx`, matching the existing icons' signature (they take `className` and render a 24×24 stroked `svg`):

```tsx
export function HandCoinsIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="16.5" cy="6.5" r="3.5" />
      <path d="M3 13.5h4l2.5 2h3a1.5 1.5 0 0 1 0 3H10" />
      <path d="M3 21h4l3-1.5 5.5-2a1.75 1.75 0 0 0-1.5-3" />
    </svg>
  )
}
```

Check the file first and copy whatever prop shape the existing icons use rather than assuming this one.

- [ ] **Step 2: Add the nav item**

In `components/AppShell.tsx`, import `HandCoinsIcon` alongside the other icons and insert into `NAV` after the Budgets entry (line 26):

```tsx
  { href: '/reimbursements', label: 'Reimbursements', short: 'Owed', Icon: HandCoinsIcon },
```

- [ ] **Step 3: Write `ClaimList`**

```tsx
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { money } from '@/lib/format'
import { Card } from './ui/Card'
import { Button } from './ui/Button'
import { ConfirmDialog } from './ui/ConfirmDialog'
import type { ClaimTotals } from '@/lib/reimbursements'

export type ClaimRow = {
  id: string
  name: string
  written_off_on: string | null
  oldestUnpaidDays: number | null
  totals: ClaimTotals
}

type Pending = { claim: ClaimRow; mode: 'write_off' | 'delete' }

export function ClaimList({ claims }: { claims: ClaimRow[] }) {
  const router = useRouter()
  const [confirming, setConfirming] = useState<Pending | null>(null)
  const [busy, setBusy] = useState(false)

  async function act({ claim, mode }: Pending) {
    setBusy(true)
    try {
      if (mode === 'delete') {
        await fetch('/api/reimbursements/claims', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: claim.id }),
        })
      } else {
        await fetch('/api/reimbursements/claims', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'write_off', id: claim.id }),
        })
      }
      setConfirming(null)
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  if (!claims.length) {
    return (
      <Card className="p-8 text-center">
        <p className="text-sm text-muted">
          Nothing outstanding. Split a transaction from the Transactions page to start tracking money
          someone owes you.
        </p>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      {claims.map((c) => {
        const pct =
          c.totals.owed > 0 ? Math.round((c.totals.returned / c.totals.owed) * 100) : 0
        return (
          <Card key={c.id} className="p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-base font-semibold text-ink">{c.name}</h2>
              <span className="text-xs text-faint">
                {c.totals.writtenOff
                  ? `Written off ${c.written_off_on}`
                  : c.totals.settled
                    ? 'Settled'
                    : `${money(c.totals.outstanding)} outstanding`}
              </span>
            </div>

            <p className="mt-1 text-sm text-muted">
              {money(c.totals.owed)} owed · {money(c.totals.returned)} back
              {c.oldestUnpaidDays != null && !c.totals.settled && !c.totals.writtenOff && (
                <> · oldest unpaid {c.oldestUnpaidDays}d</>
              )}
            </p>

            <div
              className="mt-3 h-2 overflow-hidden rounded-full bg-surface-2"
              role="progressbar"
              aria-valuenow={pct}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`${c.name} repaid`}
            >
              <div className="h-full bg-emerald" style={{ width: `${Math.min(100, pct)}%` }} />
            </div>

            {c.totals.byPerson.length > 0 && (
              <ul className="mt-4 space-y-1 text-sm">
                {c.totals.byPerson.map((p) => (
                  <li key={p.owedBy} className="flex items-center justify-between">
                    <span className="text-ink">{p.owedBy}</span>
                    <span className="tabular-nums text-muted">
                      {p.outstanding <= 0
                        ? 'paid'
                        : `${money(p.outstanding)} outstanding`}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-4 flex gap-2">
              {!c.totals.writtenOff && !c.totals.settled && (
                <Button type="button" variant="secondary" onClick={() => setConfirming({ claim: c, mode: 'write_off' })}>
                  Write off
                </Button>
              )}
              <Button type="button" variant="secondary" onClick={() => setConfirming({ claim: c, mode: 'delete' })}>
                Delete
              </Button>
            </div>
          </Card>
        )
      })}

      <ConfirmDialog
        open={confirming !== null}
        title={
          confirming?.mode === 'delete'
            ? `Delete ${confirming.claim.name}?`
            : `Write off ${confirming?.claim.name ?? ''}?`
        }
        confirmLabel={confirming?.mode === 'delete' ? 'Delete it' : 'Write it off'}
        busy={busy}
        onConfirm={() => confirming && act(confirming)}
        onCancel={() => setConfirming(null)}
      >
        {confirming?.mode === 'delete'
          ? 'This removes the claim and all its splits, so the money it was excluding goes back to counting as spending in the months it happened.'
          : `${money(confirming?.claim.totals.outstanding ?? 0)} will be counted as spending this month, in the categories it came from. This can't be undone.`}
      </ConfirmDialog>
    </div>
  )
}
```

Two details of the real `ConfirmDialog` (`components/ui/ConfirmDialog.tsx:13-29`) that the code above accounts for: it takes an `open` boolean and is always rendered (not conditionally mounted), and its body text goes in `children`, not a `message` prop.

Deleting is offered on every claim (including settled ones) because it is the only way to undo a mis-tagged claim; writing off is offered only while something is genuinely outstanding.

- [ ] **Step 4: Write the page**

```tsx
import { createClient } from '@/lib/supabase/server'
import { PageHeader } from '@/components/ui/PageHeader'
import { ClaimList, type ClaimRow } from '@/components/ClaimList'
import { claimTotals, type Claim, type Split } from '@/lib/reimbursements'

export default async function ReimbursementsPage() {
  const supabase = await createClient()

  const { data: claimRows } = await supabase
    .from('reimbursement_claims')
    .select('id, name, written_off_on')
    .order('created_at', { ascending: false })
  const { data: splitRows } = await supabase
    .from('reimbursement_splits')
    .select('transaction_id, claim_id, owed_by, amount')
  const { data: txns } = await supabase.from('transactions').select('id, amount, date')

  const amountById: Record<string, number> = {}
  const dateById: Record<string, string> = {}
  for (const t of txns ?? []) {
    amountById[t.id as string] = Number(t.amount)
    dateById[t.id as string] = t.date as string
  }

  const splits = ((splitRows ?? []) as unknown as Split[]).map((s) => ({
    ...s,
    amount: Number(s.amount),
  }))
  const today = new Date()

  const claims: ClaimRow[] = ((claimRows ?? []) as Claim[]).map((c) => {
    const mine = splits.filter((s) => s.claim_id === c.id)
    const totals = claimTotals(c, mine, amountById)
    // How long the money has been out, to tell a slow payer from a new one.
    const expenseDates = mine
      .filter((s) => (amountById[s.transaction_id] ?? 0) > 0)
      .map((s) => dateById[s.transaction_id])
      .filter(Boolean)
      .sort()
    const oldest = expenseDates[0]
    const oldestUnpaidDays =
      oldest && totals.outstanding > 0
        ? Math.floor((today.getTime() - new Date(oldest).getTime()) / 86_400_000)
        : null
    return { ...c, totals, oldestUnpaidDays }
  })

  // Open claims first, biggest outstanding at the top; settled and written-off sink to the bottom.
  claims.sort((a, b) => {
    const aDone = a.totals.writtenOff || a.totals.settled
    const bDone = b.totals.writtenOff || b.totals.settled
    if (aDone !== bDone) return aDone ? 1 : -1
    return b.totals.outstanding - a.totals.outstanding
  })

  const outstanding = claims.reduce(
    (s, c) => s + (c.totals.writtenOff ? 0 : Math.max(0, c.totals.outstanding)),
    0
  )

  return (
    <div className="space-y-6">
      <PageHeader
        title="Reimbursements"
        subtitle={
          outstanding > 0
            ? `You're owed ${outstanding.toLocaleString('en-US', { style: 'currency', currency: 'USD' })}.`
            : 'Money other people owe you, and what has come back.'
        }
      />
      <ClaimList claims={claims} />
    </div>
  )
}
```

- [ ] **Step 5: Verify**

```bash
npx tsc --noEmit && npx vitest run && npm run lint && npm run build
```

- [ ] **Step 6: Manual check**

Split a transaction three ways, then open `/reimbursements`: confirm owed/back/outstanding, the three per-person rows, and that writing off moves the outstanding amount into this month's spending on `/budgets`.

- [ ] **Step 7: Commit**

```bash
git add components/ClaimList.tsx components/ui/icons.tsx components/AppShell.tsx "app/(app)/reimbursements/page.tsx"
git commit -m "feat: reimbursements page with per-person chase tracking (#27)"
```

---

### Task 14: The dashboard entry point

**Files:**
- Modify: `app/(app)/dashboard/page.tsx`

**Interfaces:**
- Consumes: `claimTotals` (Task 6), the `/reimbursements` route (Task 13).
- Produces: nothing.

Per the spec this renders **only when something is outstanding** — zero footprint until the user has a claim. Outstanding is deliberately *not* added to net worth (§3.4).

- [ ] **Step 1: Compute the outstanding total**

In `app/(app)/dashboard/page.tsx`, alongside the existing queries. Add `claimTotals`, `type Claim` and `type Split` to the existing import from `@/lib/reimbursements`:

```tsx
  const { data: openClaims } = await supabase
    .from('reimbursement_claims')
    .select('id, name, written_off_on')
    .is('written_off_on', null)
  const { data: allSplits } = await supabase
    .from('reimbursement_splits')
    .select('transaction_id, claim_id, owed_by, amount')

  // A split can reference a transaction older than the six-month window this page already fetches for
  // `flowTxns`, so look up the amounts for exactly the referenced ids rather than reusing that list.
  const splitTxnIds = [...new Set(((allSplits ?? []) as Split[]).map((s) => s.transaction_id))]
  const { data: splitTxns } = await supabase
    .from('transactions')
    .select('id, amount')
    .in('id', splitTxnIds.length ? splitTxnIds : ['00000000-0000-0000-0000-000000000000'])
  const amountByIdForClaims: Record<string, number> = {}
  for (const t of splitTxns ?? []) amountByIdForClaims[t.id as string] = Number(t.amount)

  // Net worth deliberately does NOT include this (§3.4) — it stays real balances plus manual assets.
  const owedToYou = ((openClaims ?? []) as Claim[]).reduce((sum, c) => {
    const { outstanding } = claimTotals(
      c,
      ((allSplits ?? []) as Split[]).filter((s) => s.claim_id === c.id),
      amountByIdForClaims
    )
    return sum + Math.max(0, outstanding)
  }, 0)
```

- [ ] **Step 2: Render the line**

Place it near the stat tiles:

```tsx
      {owedToYou > 0 && (
        <a
          href="/reimbursements"
          className="flex items-center justify-between rounded-lg border border-line px-4 py-3 text-sm hover:bg-surface-2"
        >
          <span className="text-muted">Owed to you</span>
          <span className="font-medium tabular-nums text-ink">{money(owedToYou)}</span>
        </a>
      )}
```

`money` is already imported on this page; confirm before adding a duplicate import.

- [ ] **Step 3: Verify**

```bash
npx tsc --noEmit && npx vitest run && npm run lint && npm run build
```

- [ ] **Step 4: Manual check**

With an outstanding claim, confirm the line shows on the dashboard and links through. Delete or fully repay the claim and confirm the line disappears. Confirm Net Worth did **not** change when the claim was created.

- [ ] **Step 5: Commit**

```bash
git add "app/(app)/dashboard/page.tsx"
git commit -m "feat: surface outstanding reimbursements on the dashboard (#27)"
```

---

## Final verification

- [ ] Full gate, matching CI (`.github/workflows`):

```bash
npx tsc --noEmit && npm run lint && npx vitest run && npm run check:secrets && npm run build
```

- [ ] Manual RLS check (`tests/rls/` is empty, so this is by hand): sign in as a second household and confirm `/api/reimbursements/claims` returns none of the first household's claims, and that POSTing a split against a first-household transaction id fails.

- [ ] Walk the spec's success criterion end to end: front $1,000 for a rental, tag $250 each to Dave, Sam and Priya, confirm spending shows $250, tag Dave's repayment, confirm Sam and Priya still show $250 outstanding, then write off the remainder and confirm it lands in the current month.

- [ ] Confirm the cross-month case from §3.1: an expense in one month with its repayment in the next leaves **both** months undistorted.
