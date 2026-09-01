# Reimbursable Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace claims, splits and write-offs with two columns on `transactions` — how much of it is coming back, and a free-text note — keeping net worth flat and adding an expense-report view.

**Architecture:** Reimbursable stops being a row in a side table and becomes an *amount* on the transaction itself. The load-bearing rule `sign(amount) × max(0, |amount| − reimbursable)` is unchanged; only its input moves from a sum over split rows to a column. Because `SpendContext.reimbursedByTxn` is already a `Record<txnId, number>`, the five money surfaces keep their arithmetic and change only how they fill that map — and they can now fill it from rows they already fetch, deleting a query rather than adding one.

**Tech Stack:** Next.js 16 App Router (Server Components), Supabase/Postgres with RLS, TypeScript, Vitest + Testing Library, Tailwind 4.

**Spec:** `docs/superpowers/specs/2026-08-31-reimbursable-simplification-design.md`

## Global Constraints

- **Read `node_modules/next/dist/docs/` before writing Next.js code.** Per `AGENTS.md`, this version has breaking changes from training data.
- **Plaid sign convention:** `amount > 0` is money OUT, `amount < 0` is money IN. Every direction check depends on this.
- **`reimbursable_amount` is always a positive magnitude**, never signed. Direction comes from the transaction's own `amount`.
- **Never reintroduce #31 or #8:** credit-card payments must stay excluded from spending and income; refunds must net against their category rather than counting as income.
- **TDD is mandatory:** write the failing test, watch it fail, then implement. A test that passes the moment you write it has proven nothing.
- Verification commands: `npx vitest run`, `npx tsc --noEmit`, `npx eslint`, `npm run build`.
- The app has **192 passing tests at this branch's base**; no existing assertion may be weakened to make new code pass. (Not 212 — that was the count on PR #47's branch, which was CLOSED UNMERGED. This branch is off `main`. Task 2 took it to 200.)

---

### Task 1: Schema — reimbursable columns and the fresh-start guard

**Files:**
- Create: `db/migrations/015_reimbursable_amount.sql`

**Interfaces:**
- Produces: `transactions.reimbursable_amount numeric null`, `transactions.reimbursable_note text null`, constraint `reimbursable_amount_within_transaction`.

- [ ] **Step 1: Write the migration**

```sql
-- Phase 9: reimbursable becomes an AMOUNT on the transaction (spec 2026-08-31).
--
-- Replaces claims/splits/write-offs entirely. A transaction carries how much of itself is coming
-- back; direction is read from the transaction's own sign, so this is always a positive magnitude.

-- The spec assumes a fresh start: the previous feature shipped but was never used. That assumption
-- is cheap to hold and expensive to get wrong, so verify it rather than trust it. If this fires,
-- there is real money data here and the conversion in the spec's earlier draft is the starting point.
do $$
begin
  if exists (select 1 from reimbursement_splits limit 1)
     or exists (select 1 from reimbursement_write_offs limit 1) then
    raise exception
      'reimbursement data exists — this migration assumes a fresh start, see spec section 4.1';
  end if;
end $$;

alter table transactions
  add column if not exists reimbursable_amount numeric,
  add column if not exists reimbursable_note text;

-- You cannot mark more as coming back than the transaction is worth. This lives in the DATABASE
-- rather than in application code on purpose: the equivalent rule today is a cross-row sum check in
-- lib/split-validation.ts, which is correct but bypassable by any future writer that forgets to call
-- it. As a CHECK it cannot be bypassed at all.
alter table transactions
  drop constraint if exists reimbursable_amount_within_transaction;
alter table transactions
  add constraint reimbursable_amount_within_transaction
  check (
    reimbursable_amount is null
    or (reimbursable_amount > 0 and reimbursable_amount <= abs(amount))
  );

-- Partial: only marked rows are ever scanned, and most rows are never marked.
create index if not exists transactions_reimbursable_idx
  on transactions (household_id) where reimbursable_amount is not null;
```

- [ ] **Step 2: Apply it against the database and confirm the guard passes**

Run the migration in the Supabase SQL editor. Expected: success. If it raises `reimbursement data exists`, **STOP** and report — the fresh-start assumption is wrong and the plan needs revisiting.

- [ ] **Step 3: Commit**

```bash
git add db/migrations/015_reimbursable_amount.sql
git commit -m "db: reimbursable amount and note on transactions"
```

---

### Task 2: Core math — the reimbursable map and what you are owed

**Files:**
- Modify: `lib/reimbursements.ts`
- Test: `tests/unit/reimbursements.test.ts`

**Interfaces:**
- Produces:
  - `type ReimbursableTxn = { id: string; amount: number; reimbursable_amount: number | null }`
  - `reimbursableByTxn(txns: ReimbursableTxn[]): Record<string, number>`
  - `owedToYou(txns: ReimbursableTxn[]): number`
  - `spendableAmount(t, reimbursed)` — **unchanged, keep exactly as is**

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/reimbursements.test.ts`:

```typescript
import { reimbursableByTxn, owedToYou, type ReimbursableTxn } from '@/lib/reimbursements'

const txn = (id: string, amount: number, reimbursable_amount: number | null = null): ReimbursableTxn => ({
  id,
  amount,
  reimbursable_amount,
})

describe('reimbursableByTxn', () => {
  it('maps marked transactions to their amount', () => {
    expect(reimbursableByTxn([txn('t1', 500, 500), txn('t2', 40)])).toEqual({ t1: 500 })
  })

  // An unmarked map must be a provable no-op for spendableAmount, which is what lets every money
  // surface run the same code path whether or not anything is marked.
  it('omits unmarked transactions entirely rather than storing zero', () => {
    expect(reimbursableByTxn([txn('t1', 40)])).toEqual({})
  })

  it('reads a numeric column that arrives as a string', () => {
    const fromDb = { id: 't1', amount: 500, reimbursable_amount: '250.50' as unknown as number }
    expect(reimbursableByTxn([fromDb])).toEqual({ t1: 250.5 })
  })
})

describe('owedToYou', () => {
  it('counts a marked outflow as money owed to you', () => {
    expect(owedToYou([txn('t1', 500, 500)])).toBeCloseTo(500)
  })

  // The sign of the TRANSACTION carries direction; reimbursable_amount is always a magnitude.
  it('subtracts a marked inflow, because that money already came back', () => {
    expect(owedToYou([txn('t1', 500, 500), txn('t2', -200, 200)])).toBeCloseTo(300)
  })

  it('counts only the marked portion of a partly-marked expense', () => {
    expect(owedToYou([txn('t1', 1000, 750)])).toBeCloseTo(750)
  })

  it('ignores unmarked transactions', () => {
    expect(owedToYou([txn('t1', 500), txn('t2', -2772.63)])).toBe(0)
  })

  // An over-repayment is a surplus inflow, not a debt you owe your employer. Without the clamp a
  // stray overpayment would quietly REDUCE net worth.
  it('never returns a negative when more came back than went out', () => {
    expect(owedToYou([txn('t1', 500, 500), txn('t2', -600, 600)])).toBe(0)
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/unit/reimbursements.test.ts`
Expected: FAIL with `reimbursableByTxn is not a function` and `owedToYou is not a function`.

- [ ] **Step 3: Implement**

Add to `lib/reimbursements.ts` (keep `spendableAmount` exactly as it is; delete `reimbursedByTxn`, `claimTotals`, `allocateWriteOff`, `writeOffsAsTxns`, `receivableTotal` and the `Claim`/`Split`/`WriteOff`/`WriteOffTxn`/`ClaimTotals`/`PersonTotal` types in Task 11, not now):

```typescript
// A transaction as the reimbursable math sees it. `reimbursable_amount` is how much of this
// transaction is coming back — always a positive magnitude, never signed. Direction is read from
// `amount` (Plaid: amount > 0 is money out), so there is no second field that could disagree with it.
export type ReimbursableTxn = {
  id: string
  amount: number
  reimbursable_amount: number | null
}

// Transaction id -> reimbursable amount, for spendableAmount.
//
// Unmarked rows are OMITTED rather than stored as 0: spendableAmount returns a transaction untouched
// when it finds no entry, which is what makes an empty map a provable no-op for every caller.
export function reimbursableByTxn(txns: ReimbursableTxn[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const t of txns) {
    const r = Number(t.reimbursable_amount ?? 0)
    if (r > 0) out[t.id] = r
  }
  return out
}

// What the household is owed: marked money that went out, less marked money that has come back.
//
// Clamped per the whole total at zero. An over-repayment is a surplus inflow, not a debt you owe the
// other party, and must never reduce net worth.
export function owedToYou(txns: ReimbursableTxn[]): number {
  let owed = 0
  for (const t of txns) {
    const r = Number(t.reimbursable_amount ?? 0)
    if (r <= 0) continue
    owed += t.amount > 0 ? r : -r
  }
  return Math.max(0, owed)
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/unit/reimbursements.test.ts`
Expected: PASS. Existing `spendableAmount` tests must still pass unchanged.

- [ ] **Step 5: Commit**

```bash
git add lib/reimbursements.ts tests/unit/reimbursements.test.ts
git commit -m "feat: reimbursable amount map and owedToYou from the transaction column"
```

---

### Task 3: FIFO allocation for the expense-report view

**Files:**
- Modify: `lib/reimbursements.ts`
- Test: `tests/unit/reimbursements.test.ts`

**Interfaces:**
- Consumes: `ReimbursableTxn` from Task 2.
- Produces: `unreimbursedExpenses(txns: DatedReimbursableTxn[]): UnreimbursedRow[]` where
  `type DatedReimbursableTxn = ReimbursableTxn & { date: string }` and
  `type UnreimbursedRow = { id: string; date: string; remaining: number }`.

- [ ] **Step 1: Write the failing tests**

```typescript
import { unreimbursedExpenses, type DatedReimbursableTxn } from '@/lib/reimbursements'

const exp = (id: string, date: string, amount: number, marked: number): DatedReimbursableTxn => ({
  id,
  date,
  amount,
  reimbursable_amount: marked,
})
const dep = (id: string, date: string, amount: number, marked: number): DatedReimbursableTxn => ({
  id,
  date,
  amount: -amount,
  reimbursable_amount: marked,
})

describe('unreimbursedExpenses', () => {
  it('lists a marked expense with nothing paid back', () => {
    expect(unreimbursedExpenses([exp('t1', '2026-08-01', 105, 105)])).toEqual([
      { id: 't1', date: '2026-08-01', remaining: 105 },
    ])
  })

  // FIFO: deposits settle the OLDEST outstanding expenses first. This is what makes the view correct
  // without knowing which deposit paid which expense — the whole reason the model has no claims.
  it('settles the oldest expenses first', () => {
    const rows = unreimbursedExpenses([
      exp('t1', '2026-08-01', 100, 100),
      exp('t2', '2026-08-10', 105, 105),
      dep('d1', '2026-08-18', 100, 100),
    ])
    expect(rows).toEqual([{ id: 't2', date: '2026-08-10', remaining: 105 }])
  })

  it('reports the remainder of a partly-covered expense', () => {
    const rows = unreimbursedExpenses([
      exp('t1', '2026-08-01', 100, 100),
      dep('d1', '2026-08-18', 60, 60),
    ])
    expect(rows).toEqual([{ id: 't1', date: '2026-08-01', remaining: 40 }])
  })

  it('leaves nothing outstanding when the deposits cover everything', () => {
    expect(
      unreimbursedExpenses([exp('t1', '2026-08-01', 100, 100), dep('d1', '2026-08-18', 150, 150)])
    ).toEqual([])
  })

  // Timing is exactly what this must NOT depend on: submitted on the 15th, paid on the 20th, with an
  // expense on the 17th that was never claimed. A date rule drops that expense; FIFO on amounts keeps it.
  it('keeps an expense dated between a submission and its deposit', () => {
    const rows = unreimbursedExpenses([
      exp('t1', '2026-08-10', 100, 100),
      exp('t2', '2026-08-17', 45, 45),
      dep('d1', '2026-08-20', 100, 100),
    ])
    expect(rows).toEqual([{ id: 't2', date: '2026-08-17', remaining: 45 }])
  })

  it('ignores unmarked transactions in both directions', () => {
    const rows = unreimbursedExpenses([
      exp('t1', '2026-08-01', 100, 100),
      { id: 'salary', date: '2026-08-29', amount: -2772.63, reimbursable_amount: null },
      { id: 'coffee', date: '2026-08-02', amount: 17.16, reimbursable_amount: null },
    ])
    expect(rows).toEqual([{ id: 't1', date: '2026-08-01', remaining: 100 }])
  })

  it('does not leave a sub-cent residue as an outstanding row', () => {
    const rows = unreimbursedExpenses([
      exp('t1', '2026-08-01', 33.33, 33.33),
      dep('d1', '2026-08-18', 33.33, 33.33),
    ])
    expect(rows).toEqual([])
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/unit/reimbursements.test.ts -t unreimbursedExpenses`
Expected: FAIL with `unreimbursedExpenses is not a function`.

- [ ] **Step 3: Implement**

```typescript
export type DatedReimbursableTxn = ReimbursableTxn & { date: string }
export type UnreimbursedRow = { id: string; date: string; remaining: number }

// The expense report: marked expenses the marked deposits have not covered yet.
//
// Allocation is FIFO on AMOUNTS, never on dates. A date rule loses money — submit a report on the
// 15th, get paid on the 20th, and an expense on the 17th sits BEFORE the last deposit and reads as
// already-paid despite never having been claimed. Matching on amounts removes timing from the
// problem, which matters because this household submits on no fixed rhythm.
//
// Pure and stateless: nothing is stored, so it recomputes correctly no matter what order rows are
// marked in, and there is no settled-flag that could drift from the numbers it summarises.
export function unreimbursedExpenses(txns: DatedReimbursableTxn[]): UnreimbursedRow[] {
  const expenses = txns
    .filter((t) => t.amount > 0 && Number(t.reimbursable_amount ?? 0) > 0)
    .sort((a, b) => a.date.localeCompare(b.date))

  let pool = txns
    .filter((t) => t.amount < 0)
    .reduce((s, t) => s + Number(t.reimbursable_amount ?? 0), 0)

  const out: UnreimbursedRow[] = []
  for (const e of expenses) {
    const marked = Number(e.reimbursable_amount)
    const covered = Math.min(pool, marked)
    pool -= covered
    const remaining = round2(marked - covered)
    // Only a fully-covered expense should vanish. `> 0` rather than `!== 0` drops sub-cent residues
    // from repeated rounding, which would otherwise render as a junk "$0.00 outstanding" row.
    if (remaining > 0) out.push({ id: e.id, date: e.date, remaining })
  }
  return out
}
```

`round2` already exists at the bottom of `lib/reimbursements.ts` — reuse it, do not redefine it.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/unit/reimbursements.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/reimbursements.ts tests/unit/reimbursements.test.ts
git commit -m "feat: FIFO allocation of deposits against outstanding expenses"
```

---

### Task 4: Slim SpendContext — no splits, no write-offs

**Files:**
- Modify: `lib/spend-context.ts`
- Test: `tests/unit/spend-context.test.ts`

**Interfaces:**
- Consumes: `reimbursableByTxn` from Task 2.
- Produces: `buildSpendContext({ categories, txns })` where `txns: ReimbursableTxn[]`. `SpendContext` keeps `pfcMap`, `nonSpending`, `transfers`, `reimbursedByTxn`; **`writeOffs` and `withWriteOffs` are removed.**

- [ ] **Step 1: Rewrite the tests for the new shape**

Replace the write-off cases in `tests/unit/spend-context.test.ts` with:

```typescript
import { buildSpendContext } from '@/lib/spend-context'

describe('buildSpendContext', () => {
  const categories = [
    { id: '1', name: 'Food & Drink', pfc_primary: 'FOOD_AND_DRINK', sort_order: 1 },
    { id: '2', name: 'Income', pfc_primary: 'INCOME', sort_order: 2 },
  ]

  // The context is built from the SAME rows the surface renders, so a page cannot fetch its
  // transactions and then forget to fetch what is reimbursable about them — they arrive together.
  it('builds the reimbursable map from the transactions themselves', () => {
    const ctx = buildSpendContext({
      categories,
      txns: [
        { id: 't1', amount: 105, reimbursable_amount: 105 },
        { id: 't2', amount: 17.16, reimbursable_amount: null },
      ],
    })
    expect(ctx.reimbursedByTxn).toEqual({ t1: 105 })
  })

  it('carries an empty map when nothing is marked', () => {
    const ctx = buildSpendContext({ categories, txns: [{ id: 't1', amount: 40, reimbursable_amount: null }] })
    expect(ctx.reimbursedByTxn).toEqual({})
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/unit/spend-context.test.ts`
Expected: FAIL — `buildSpendContext` still requires `splits` and `writeOffs`.

- [ ] **Step 3: Implement**

Replace `lib/spend-context.ts` entirely:

```typescript
import { pfcToName, nonSpendingNames, transferNames, type Category } from './categories'
import { reimbursableByTxn, type ReimbursableTxn } from './reimbursements'

// Everything the spending calculations need, assembled once per page. Bundled into one object
// because the five money surfaces used to assemble these by hand: a page that forgot the reimbursable
// map would still compile and silently report reimbursable money as spending.
export type SpendContext = {
  pfcMap: Record<string, string> // Plaid PFC primary -> category NAME
  nonSpending: Set<string> // income + transfers (excluded from spending)
  transfers: Set<string> // transfers only (excluded from income too)
  reimbursedByTxn: Record<string, number> // transaction id -> reimbursable amount
}

// `txns` are the surface's OWN rows. Reimbursable now lives on the transaction, so the map is built
// from what the page already fetched — there is no second query to forget, and no window mismatch
// between the transactions and the thing that modifies them. This deletes the whole class of bug the
// old `writeOffs` field existed to prevent, by removing the second source of data rather than
// guarding it.
export function buildSpendContext(input: {
  categories: Category[]
  txns: ReimbursableTxn[]
}): SpendContext {
  return {
    pfcMap: pfcToName(input.categories),
    nonSpending: nonSpendingNames(input.categories),
    transfers: transferNames(input.categories),
    reimbursedByTxn: reimbursableByTxn(input.txns),
  }
}
```

- [ ] **Step 4: Run to verify**

Run: `npx vitest run tests/unit/spend-context.test.ts`
Expected: PASS. Other suites will fail to compile — that is Task 5.

- [ ] **Step 5: Commit**

```bash
git add lib/spend-context.ts tests/unit/spend-context.test.ts
git commit -m "refactor: SpendContext reads reimbursable from the transactions it was given"
```

---

### Task 5: Point the five money surfaces at the column

**Files:**
- Modify: `app/(app)/dashboard/page.tsx`, `app/(app)/budgets/page.tsx`, `app/(app)/trends/page.tsx`, `app/(app)/breakdown/[metric]/page.tsx`, `app/(app)/transactions/page.tsx`

**Interfaces:**
- Consumes: `buildSpendContext({ categories, txns })` from Task 4.

Each surface changes the same three ways. **This is a deletion, not an addition** — every page loses a query.

- [ ] **Step 1: Add the column to each transactions select**

In every page that selects transactions for money math, add `reimbursable_amount` to the select list. Example, `app/(app)/dashboard/page.tsx`:

```typescript
    .select('id, amount, date, user_category, pfc_primary, pfc_detailed, reimbursable_amount')
```

- [ ] **Step 2: Build the context from those rows**

Replace each `buildSpendContext({ categories, splits, writeOffs })` call with:

```typescript
  const ctx = buildSpendContext({ categories, txns: (flowTxns ?? []) as Txn[] })
```

(the variable holding that page's transactions differs per page — `flowTxns`, `txns`, or `list`).

- [ ] **Step 3: Delete the splits query, the write-offs query, and every `withWriteOffs` call**

Remove:
- the `.from('reimbursement_splits')` query and its `splitRows` handling
- the `.from('reimbursement_write_offs')` query, its `woQuery`/`writeOffRows`, and the `monthStart`/`monthEnd` computation **only where it exists solely to window the write-offs** (`transactions/page.tsx` — check whether the transactions query itself still needs it before deleting)
- `withWriteOffs(...)` wrappers: `const allRows = withWriteOffs(x, ctx)` becomes `const allRows = x`
- the now-unused `withWriteOffs`, `Split`, `WriteOff` imports

- [ ] **Step 4: Add `reimbursable_amount` to the `Txn` type**

In `lib/budget.ts`:

```typescript
export type Txn = {
  id: string
  amount: number
  date: string
  user_category: string | null
  pfc_primary: string | null
  pfc_detailed: string | null
  reimbursable_amount: number | null
}
```

- [ ] **Step 5: Verify the whole suite and the types**

Run: `npx tsc --noEmit && npx vitest run`
Expected: types clean. Existing `budget`/`dashboard`/`breakdown` tests must pass with their **expected values unchanged** — the arithmetic did not move, only its input. Any test whose fixture used splits gets its fixture rewritten to set `reimbursable_amount` on the transaction; **the expected totals must stay the same numbers.**

- [ ] **Step 6: Commit**

```bash
git add app lib tests
git commit -m "refactor: money surfaces read reimbursable from the transaction, not from splits"
```

---

### Task 6: Net worth counts what you are owed

**Files:**
- Modify: `lib/receivable.ts`
- Test: `tests/unit/dashboard.test.ts` (existing `netWorth` receivable tests must keep passing unchanged)

**Interfaces:**
- Consumes: `owedToYou` from Task 2.
- Produces: `fetchReceivable(): Promise<number>` — same signature as today, different query.

- [ ] **Step 1: Rewrite the query**

Replace the body of `fetchReceivable` in `lib/receivable.ts`:

```typescript
import 'server-only'
import { createClient } from '@/lib/supabase/server'
import { owedToYou, type ReimbursableTxn } from '@/lib/reimbursements'

// NOTE: the pure `owedToYou` lives in lib/reimbursements.ts so it stays importable in unit tests —
// this module pulls in the request-scoped client at load.

// What the household is currently owed, for every surface that shows net worth.
//
// One function because the QUERY is where two surfaces would drift apart, not the arithmetic: a Net
// worth tile that disagrees with its own drill-down is the exact bug the drill-down was built to
// expose. Callers pass the total to netWorth(); nobody re-derives it.
export async function fetchReceivable(): Promise<number> {
  const supabase = await createClient()

  // Bounded by the partial index: only marked rows exist in it, and a household has few. `removed`
  // is a soft flag (a Plaid repost), not a delete, so its rows never disappear on their own — a
  // removed transaction's mark must not keep counting as money owed.
  const { data, error } = await supabase
    .from('transactions')
    .select('id, amount, reimbursable_amount')
    .not('reimbursable_amount', 'is', null)
    .eq('removed', false)

  // Fail loudly rather than reporting $0 owed. An unchecked read here is issue #46 in a new costume:
  // "the query failed" and "you are owed nothing" must never render identically.
  if (error) throw new Error(`could not read reimbursable transactions: ${error.message}`)

  return owedToYou((data ?? []) as ReimbursableTxn[])
}
```

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit && npx vitest run tests/unit/dashboard.test.ts tests/unit/breakdown.test.ts`
Expected: PASS. `netWorth(accounts, receivable)` and the reconciliation tests are untouched by this change and must stay green.

- [ ] **Step 3: Commit**

```bash
git add lib/receivable.ts
git commit -m "refactor: receivable comes from marked transactions, and fails loudly on a read error"
```

---

### Task 6b: Wire the receivable into net worth (ADDED MID-EXECUTION)

> **Why this task exists:** Task 6's review found `fetchReceivable` has ZERO callers, and `netWorth`
> on this branch is still single-argument. The two-argument signature and the wiring both lived only
> in PR #47, which was closed unmerged — the plan described a branch that does not exist. Without
> this task, all twelve tasks complete and net worth still never counts what you are owed, which is
> the single behaviour the spec's §2 formula promises.

**Files:**
- Modify: `lib/dashboard.ts`, `app/(app)/dashboard/page.tsx`, `app/(app)/breakdown/[metric]/page.tsx`
- Test: `tests/unit/dashboard.test.ts`, `tests/unit/breakdown.test.ts`

**Interfaces:**
- Consumes: `fetchReceivable(): Promise<number>` from Task 6, `owedToYou` from Task 2.
- Produces: `netWorth(accounts: Acct[], receivable: number): number`.

**Reference implementation:** this exact work was done on the closed branch and can be read with
`git show feat/reimbursable-checkbox:lib/dashboard.ts` and the same for the two pages. Read it, but
port rather than cherry-pick — that branch's version computes the receivable from claims and splits,
which no longer exist.

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/dashboard.test.ts`:

```typescript
  // A reimbursable expense takes the cash out today but is money that comes back, so it must not
  // read as a loss. The receivable offsets the cash that left.
  it('counts outstanding reimbursements as a receivable', () => {
    expect(netWorth([{ type: 'depository', current_balance: 8000 }], 500)).toBe(8500)
  })

  // The offset is the whole point: spending $500 you will get back leaves net worth where it was.
  it('leaves net worth flat when cash out equals what is owed back', () => {
    const before = netWorth([{ type: 'depository', current_balance: 8000 }], 0)
    const after = netWorth([{ type: 'depository', current_balance: 7500 }], 500)
    expect(after).toBe(before)
  })
```

Add to `tests/unit/breakdown.test.ts`:

```typescript
// The Net worth tile and its drill-down are computed by two different modules: the tile by netWorth()
// in lib/dashboard.ts, the rows by groupAccountsByKind() here. They classify account types
// independently, so nothing but this test stops one of them learning about a new type and the
// drill-down quietly failing to add up to the number the user clicked.
describe('net worth reconciliation', () => {
  const accounts = [
    acct('a1', 'depository', 8000),
    acct('a2', 'investment', 2000),
    acct('a3', 'other', 100),
    acct('a4', 'credit', 500),
    acct('a5', 'loan', 10000),
    acct('a6', null, 999), // unknown type: ignored by BOTH sides, which is itself the invariant
  ]
  const manualAssets = [{ value: 400_000 }]

  it('breakdown rows sum to the same total as the net worth tile', () => {
    const receivable = 500
    const tile = netWorth(accounts, receivable) + sumManualAssets(manualAssets)
    const g = groupAccountsByKind(accounts)
    const rows = g.assetTotal - g.liabilityTotal + sumManualAssets(manualAssets) + receivable
    expect(rows).toBeCloseTo(tile)
  })
})
```

Import `netWorth` and `sumManualAssets` from `@/lib/dashboard` in `breakdown.test.ts`.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/unit/dashboard.test.ts tests/unit/breakdown.test.ts`
Expected: FAIL — `netWorth` currently ignores a second argument, so the receivable tests get the
un-offset number.

- [ ] **Step 3: Make `receivable` a required parameter**

In `lib/dashboard.ts`:

```typescript
// Net worth = assets - liabilities across all connected accounts, plus what you are owed back.
//
// `receivable` is REQUIRED rather than defaulted: every surface that shows net worth has to state
// what it counts as owed to you, so a page that forgets is a type error rather than a screen quietly
// disagreeing with the dashboard about the same household. Pass 0 to count only real balances.
// See fetchReceivable() in lib/receivable.ts for what belongs in it.
export function netWorth(accounts: Acct[], receivable: number): number {
```

and return `assets - liabilities + receivable`.

The two existing calls in `tests/unit/dashboard.test.ts` gain an explicit `, 0` — their expected
values do NOT change.

- [ ] **Step 4: Wire both pages**

`app/(app)/dashboard/page.tsx`: `const owedToYou = await fetchReceivable()` and
`const worth = netWorth(accounts, owedToYou) + sumManualAssets(manualAssets)`.

`app/(app)/breakdown/[metric]/page.tsx`, in the `net-worth` branch: fetch the receivable, add an
"Owed to you" row on the asset side linking to `/reimbursements`, and include it in the total so the
drill-down still reconciles with the tile:

```typescript
    const receivable = await fetchReceivable()
    const receivableRows: BreakdownRow[] =
      receivable > 0
        ? [
            {
              key: 'receivable',
              label: 'Owed to you',
              sub: 'Outstanding reimbursements',
              amount: receivable,
              currency,
              owed: false,
              href: '/reimbursements',
            },
          ]
        : []
```

Insert `...receivableRows` after the manual-asset rows, and make the total
`netWorth(accounts, receivable) + sumManualAssets(manualAssets)`.

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit && npx vitest run && npx eslint && npm run build`
Expected: all clean. The type error on any un-updated `netWorth` caller is the point of the required
parameter — fix each one rather than defaulting it.

- [ ] **Step 6: Commit**

```bash
git add lib app tests
git commit -m "feat: net worth counts what you are owed"
```

---

### Task 7: One route to mark a transaction

**Files:**
- Create: `app/api/reimbursable/route.ts`
- Test: `tests/unit/reimbursable-amount.test.ts`

**Interfaces:**
- Produces: `PATCH /api/reimbursable` accepting `{ transactionId: string, amount: number | null, note?: string | null }`. `amount: null` clears the mark. Responds `{ ok: true }` or `{ error }`.
- Produces: `clampReimbursable(amount: number | null, txnAmount: number): number | null` in `lib/reimbursements.ts`.

- [ ] **Step 1: Write the failing test for the clamp**

```typescript
import { clampReimbursable } from '@/lib/reimbursements'

// The DB CHECK refuses anything above abs(amount). Clamping BEFORE the write turns a 500 from a
// constraint violation into the sensible answer, and is also what keeps a Plaid amount revision
// from wedging a row that was valid when it was marked.
describe('clampReimbursable', () => {
  it('passes a valid amount through', () => {
    expect(clampReimbursable(750, 1000)).toBe(750)
  })

  it('caps at the transaction amount', () => {
    expect(clampReimbursable(1500, 1000)).toBe(1000)
  })

  it('uses the magnitude, so an inflow can be marked', () => {
    expect(clampReimbursable(200, -260)).toBe(200)
    expect(clampReimbursable(500, -260)).toBe(260)
  })

  it('treats null as clearing the mark', () => {
    expect(clampReimbursable(null, 1000)).toBeNull()
  })

  // A zero or negative mark is not a mark. It must clear rather than violate the CHECK's `> 0`.
  it('clears rather than storing zero or a negative', () => {
    expect(clampReimbursable(0, 1000)).toBeNull()
    expect(clampReimbursable(-5, 1000)).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/reimbursable-amount.test.ts`
Expected: FAIL with `clampReimbursable is not a function`.

- [ ] **Step 3: Implement the clamp**

In `lib/reimbursements.ts`:

```typescript
// What may actually be stored in `reimbursable_amount`, given the transaction it belongs to.
//
// The database CHECK is the real guarantee; this exists so the app never ASKS for something the
// CHECK will refuse. Clamping turns "you typed more than the transaction is worth" into the obvious
// answer instead of a 500 from a constraint violation.
export function clampReimbursable(amount: number | null, txnAmount: number): number | null {
  if (amount === null || !Number.isFinite(amount) || amount <= 0) return null
  return Math.min(round2(amount), Math.abs(txnAmount))
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/reimbursable-amount.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the route**

Create `app/api/reimbursable/route.ts`:

```typescript
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { clampReimbursable } from '@/lib/reimbursements'
import { isCreditCardPayment } from '@/lib/categories'

// Mark how much of a transaction is coming back, or clear the mark. One route, one column — there is
// no claim to create, no person to name, and no second row to keep in step with this one.
export async function PATCH(req: Request) {
  const { transactionId, amount, note } = await req.json()
  if (!transactionId) {
    return NextResponse.json({ error: 'transactionId required' }, { status: 400 })
  }

  const supabase = await createClient()

  const { data: txn, error: readError } = await supabase
    .from('transactions')
    // pfc_detailed and user_category are here only to evaluate isCreditCardPayment below.
    .select('id, amount, removed, pfc_detailed, user_category')
    .eq('id', transactionId)
    .maybeSingle()
  // Fail closed: a read error must not be mistaken for "no such transaction".
  if (readError) return NextResponse.json({ error: 'could not read the transaction' }, { status: 500 })
  if (!txn) return NextResponse.json({ error: 'transaction not found' }, { status: 404 })

  // `removed` is a soft flag (a Plaid repost), not a delete, so nothing stops a mark being written
  // to a row that no longer renders anywhere. That mark would then be unreachable while still
  // counting toward what you are owed.
  if (txn.removed) {
    return NextResponse.json({ error: 'that transaction was removed' }, { status: 400 })
  }

  // Guards #31. A credit-card payment is already excluded from both spending and income — the
  // purchases were counted when they happened — so marking it reduces nothing while still inflating
  // what you are owed. Refuse at the source rather than relying on every reader to filter it out.
  if (isCreditCardPayment(txn)) {
    return NextResponse.json(
      { error: 'a credit-card payment is already excluded from spending' },
      { status: 400 }
    )
  }

  const { error } = await supabase
    .from('transactions')
    .update({
      reimbursable_amount: clampReimbursable(amount === null ? null : Number(amount), Number(txn.amount)),
      reimbursable_note: (note ?? '').trim() || null,
    })
    .eq('id', transactionId)
  if (error) return NextResponse.json({ error: error.message }, { status: 400 })

  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 6: Verify**

Run: `npx tsc --noEmit && npx vitest run && npx eslint`
Expected: all clean.

- [ ] **Step 7: Commit**

```bash
git add app/api/reimbursable/route.ts lib/reimbursements.ts tests/unit/reimbursable-amount.test.ts
git commit -m "feat: one route to mark how much of a transaction is coming back"
```

---

### Task 8: Marks survive a Plaid sync — and a revised amount does not wedge it

**Files:**
- Modify: `lib/ingest.ts`
- Test: `tests/unit/ingest-reimbursable.test.ts`

**Interfaces:**
- Consumes: `clampReimbursable` from Task 7.
- Produces: `transactionUpsertRow(t, householdId)` exported from `lib/ingest.ts`.

The spec calls for two guarantees here, and **neither is currently asserted anywhere**. The first is
why `user_category` has survived since launch; the second is a hazard the new CHECK constraint
introduces, which did not exist before this change.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, it, expect } from 'vitest'
import { transactionUpsertRow } from '@/lib/ingest'
import { clampReimbursable } from '@/lib/reimbursements'

const plaidTxn = {
  account_id: 'acct-1',
  transaction_id: 'plaid-1',
  amount: 105,
  date: '2026-08-29',
  name: 'JOE S DEN',
  merchant_name: 'Joe S Den',
  personal_finance_category: { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_RESTAURANT', confidence_level: 'HIGH' },
}

// The ONLY thing stopping a sync from wiping a user's marks is that these columns are absent from the
// upsert payload — PostgREST's ON CONFLICT DO UPDATE touches exactly the keys it is given. That is a
// property of this object's shape, not of anything the schema declares, so adding a column to it
// would silently start clobbering user data on every sync. This test is the tripwire.
describe('transactionUpsertRow', () => {
  it('never writes the user-owned columns', () => {
    const keys = Object.keys(transactionUpsertRow(plaidTxn, 'hh-1'))
    expect(keys).not.toContain('reimbursable_amount')
    expect(keys).not.toContain('reimbursable_note')
    expect(keys).not.toContain('user_category')
  })

  it('still writes every Plaid-owned column', () => {
    expect(transactionUpsertRow(plaidTxn, 'hh-1')).toEqual({
      household_id: 'hh-1',
      account_id: 'acct-1',
      plaid_transaction_id: 'plaid-1',
      amount: 105,
      date: '2026-08-29',
      name: 'JOE S DEN',
      merchant_name: 'Joe S Den',
      pfc_primary: 'FOOD_AND_DRINK',
      pfc_detailed: 'FOOD_AND_DRINK_RESTAURANT',
      pfc_confidence: 'HIGH',
      removed: false,
    })
  })
})

// The hazard the CHECK introduces. Plaid revises amounts on `modified` — a $105 authorisation
// settling at $95, say. If $105 was marked reimbursable, the revised row violates
// reimbursable_amount <= abs(amount) and the whole sync throws, wedging every later transaction
// behind it. Clamping first turns a broken sync into the obvious answer.
describe('clamping a mark to a revised amount', () => {
  it('lowers a mark that a revised amount would invalidate', () => {
    expect(clampReimbursable(105, 95)).toBe(95)
  })

  it('leaves a mark alone when it still fits', () => {
    expect(clampReimbursable(50, 95)).toBe(50)
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/unit/ingest-reimbursable.test.ts`
Expected: FAIL with `transactionUpsertRow is not a function`.

- [ ] **Step 3: Extract the row builder**

In `lib/ingest.ts`, lift the inline `.map()` at line 44 into a named export and call it:

```typescript
// The upsert payload for one Plaid transaction.
//
// EXPORTED so a test can assert what is NOT in it. PostgREST's ON CONFLICT DO UPDATE writes exactly
// the keys present here, which is the only reason user-owned columns (`user_category`,
// `reimbursable_amount`, `reimbursable_note`) survive a re-sync. Adding one of them to this object
// would silently clobber the user's own data on every sync — see tests/unit/ingest-reimbursable.test.ts.
export function transactionUpsertRow(
  t: {
    account_id: string
    transaction_id: string
    amount: number
    date: string
    name: string
    merchant_name?: string | null
    personal_finance_category?: { primary?: string; detailed?: string; confidence_level?: string } | null
  },
  householdId: string
) {
  return {
    household_id: householdId,
    account_id: t.account_id,
    plaid_transaction_id: t.transaction_id,
    amount: t.amount,
    date: t.date,
    name: t.name,
    merchant_name: t.merchant_name ?? null,
    pfc_primary: t.personal_finance_category?.primary ?? null,
    pfc_detailed: t.personal_finance_category?.detailed ?? null,
    pfc_confidence: t.personal_finance_category?.confidence_level ?? null,
    removed: false,
  }
}
```

Then: `const upserts = [...added, ...modified].map((t) => transactionUpsertRow(t, item.household_id))`

- [ ] **Step 4: Clamp existing marks before the upsert**

Immediately before the upsert in `syncTransactions`, add:

```typescript
  // A `modified` transaction can arrive with a SMALLER amount than the one already stored (an
  // authorisation settling lower). If the stored mark now exceeds it, the upsert violates the
  // reimbursable_amount CHECK and the entire sync throws — taking every later transaction with it.
  // Lower the mark to what the transaction is now worth, then let the upsert proceed.
  if (modified.length) {
    const ids = modified.map((t) => t.transaction_id)
    const { data: marked } = await supabaseAdmin
      .from('transactions')
      .select('plaid_transaction_id, reimbursable_amount')
      .in('plaid_transaction_id', ids)
      .not('reimbursable_amount', 'is', null)

    for (const row of marked ?? []) {
      const incoming = modified.find((t) => t.transaction_id === row.plaid_transaction_id)
      if (!incoming) continue
      const clamped = clampReimbursable(Number(row.reimbursable_amount), incoming.amount)
      if (clamped !== Number(row.reimbursable_amount)) {
        await supabaseAdmin
          .from('transactions')
          .update({ reimbursable_amount: clamped })
          .eq('plaid_transaction_id', row.plaid_transaction_id)
      }
    }
  }
```

Import `clampReimbursable` from `@/lib/reimbursements` at the top of the file.

- [ ] **Step 5: Run to verify they pass**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS, and the existing `tests/unit/sync.test.ts` stays green.

- [ ] **Step 6: Commit**

```bash
git add lib/ingest.ts tests/unit/ingest-reimbursable.test.ts
git commit -m "fix: marks survive a sync, and a revised amount cannot wedge one"
```

---

### Task 9: The tick box and the overflow menu

**Files:**
- Create: `components/ReimbursableCheckbox.tsx`, `components/RowMenu.tsx`, `components/ReimbursableEditor.tsx`
- Modify: `components/TransactionRow.tsx`, `app/(app)/transactions/page.tsx`
- Test: `tests/unit/reimbursable-checkbox.test.tsx`

**Interfaces:**
- Produces: `<ReimbursableCheckbox transactionId amount reimbursableAmount label />`, `<RowMenu label>{children}</RowMenu>`, `<ReimbursableEditor transactionId amount reimbursableAmount note />`.

- [ ] **Step 1: Write the failing component tests**

Adapt `tests/unit/reimbursable-button.test.tsx` (from the closed PR #47 branch — `git show feat/reimbursable-checkbox:tests/unit/reimbursable-button.test.tsx`) into `tests/unit/reimbursable-checkbox.test.tsx`:

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { ReimbursableCheckbox } from '@/components/ReimbursableCheckbox'

afterEach(cleanup)
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }))

const props = { transactionId: 't1', amount: 78, reimbursableAmount: null, label: 'Starbucks' }

describe('ReimbursableCheckbox', () => {
  it('is unticked when nothing is marked', () => {
    render(<ReimbursableCheckbox {...props} />)
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
  })

  it('is ticked when the whole transaction is marked', () => {
    render(<ReimbursableCheckbox {...props} reimbursableAmount={78} />)
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true)
  })

  // The column header is announced in table navigation but NOT when focus lands on the input, so
  // without this a screen reader hears "checkbox" down forty rows with nothing to tell them apart.
  it('names the row it belongs to', () => {
    render(<ReimbursableCheckbox {...props} />)
    expect(screen.getByRole('checkbox', { name: /Starbucks/ })).toBeTruthy()
  })

  // A partial mark is NOT a binary state. A ticked box beside "$750 of $1,000" would claim the whole
  // charge is coming back; an unticked one would claim none of it is. Both are lies, so it shows the
  // amount instead and sends the user to the editor.
  it('shows the marked amount rather than a box when only part is marked', () => {
    render(<ReimbursableCheckbox {...props} amount={1000} reimbursableAmount={750} />)
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.getByText(/750/)).toBeTruthy()
  })

  it('renders nothing on a credit-card payment', () => {
    const { container } = render(
      <ReimbursableCheckbox {...props} pfcDetailed="LOAN_PAYMENTS_CREDIT_CARD_PAYMENT" />
    )
    expect(container.firstChild).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/unit/reimbursable-checkbox.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `ReimbursableCheckbox`**

```typescript
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { money } from '@/lib/format'
import { isCreditCardPayment } from '@/lib/categories'

export function ReimbursableCheckbox({
  transactionId,
  amount,
  reimbursableAmount,
  note,
  label,
  pfcDetailed = null,
  userCategory = null,
}: {
  transactionId: string
  amount: number
  reimbursableAmount: number | null
  note?: string | null
  label: string
  pfcDetailed?: string | null
  userCategory?: string | null
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Guards #31: the route refuses these, so offering the control would only ever produce an error.
  if (isCreditCardPayment({ pfc_detailed: pfcDetailed, user_category: userCategory })) return null

  const marked = Number(reimbursableAmount ?? 0)
  const full = Math.abs(amount)
  const partial = marked > 0 && marked < full

  async function set(next: number | null) {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/reimbursable', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transactionId, amount: next, note: note ?? null }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setError(body.error ?? 'That could not be saved.')
        return
      }
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  // A partial mark has no honest tick state — see the test. Show what is marked; the editor in the
  // row menu is where it changes.
  if (partial) {
    return (
      <span className="text-xs font-medium text-emerald" title={note ?? undefined}>
        {money(marked)} of {money(full)}
      </span>
    )
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <label className="flex cursor-pointer items-center gap-1.5 text-xs font-medium text-emerald hover:text-emerald-600">
        <input
          type="checkbox"
          checked={marked > 0}
          onChange={() => set(marked > 0 ? null : full)}
          disabled={busy}
          aria-label={`Reimbursable — ${label}`}
          className="h-3.5 w-3.5 accent-emerald disabled:opacity-50"
        />
      </label>
      {error && (
        <span role="alert" className="text-xs text-coral">
          {error}
        </span>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/unit/reimbursable-checkbox.test.tsx`
Expected: PASS.

- [ ] **Step 5: Implement `RowMenu` and `ReimbursableEditor`**

`components/RowMenu.tsx` — a native `<details>` disclosure, matching the pattern the old fast-path dropdown used (works inside a table cell with no layout maths, keyboard-accessible for free):

```typescript
'use client'

export function RowMenu({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <details className="text-right">
      <summary
        className="cursor-pointer list-none text-xs font-medium text-muted hover:text-ink"
        aria-label={`More actions for ${label}`}
      >
        ⋮
      </summary>
      <div className="mt-1 flex flex-col items-end gap-1">{children}</div>
    </details>
  )
}
```

`components/ReimbursableEditor.tsx`:

```typescript
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { money } from '@/lib/format'
import { inputClass } from './ui/styles'

export function ReimbursableEditor({
  transactionId,
  amount,
  reimbursableAmount,
  note,
}: {
  transactionId: string
  amount: number
  reimbursableAmount: number | null
  note: string | null
}) {
  const router = useRouter()
  const full = Math.abs(amount)
  const [value, setValue] = useState(String(reimbursableAmount ?? ''))
  const [memo, setMemo] = useState(note ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save(next: number | null) {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/reimbursable', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transactionId, amount: next, note: memo }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setError(body.error ?? 'That could not be saved.')
        return
      }
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-2 text-left">
      <label className="text-xs text-muted">
        How much of {money(full)} is coming back?
        <input
          type="number"
          step="0.01"
          min="0"
          // The route clamps too, and the DB CHECK is the real guarantee. This is only so the field
          // does not invite a number that would come straight back as an error.
          max={full}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className={inputClass}
        />
      </label>
      <label className="text-xs text-muted">
        Note (optional)
        <input
          type="text"
          value={memo}
          onChange={(e) => setMemo(e.target.value)}
          placeholder="Dave, Sam, Priya"
          className={inputClass}
        />
      </label>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => save(value === '' ? null : Number(value))}
          className="text-xs font-medium text-emerald hover:text-emerald-600 disabled:opacity-50"
        >
          Save
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => save(null)}
          className="text-xs font-medium text-muted hover:text-ink disabled:opacity-50"
        >
          Clear
        </button>
      </div>
      {error && (
        <span role="alert" className="text-xs text-coral">
          {error}
        </span>
      )}
    </div>
  )
}
```

Check `components/ui/styles.ts` for the exact exported input class name before using `inputClass`; if it does not exist, reuse the `selectClass` string's border/padding classes rather than inventing new ones.

- [ ] **Step 6: Wire into `TransactionRow`**

The `REIMBURSABLE` column holds `<ReimbursableCheckbox />`. The final column's `Split` link becomes `<RowMenu>` containing the editor toggle. Keep the 6-column layout and `colgroup` from the closed PR (`git show feat/reimbursable-checkbox:app/\(app\)/transactions/page.tsx`), renaming the last header from `Split` to a `sr-only` "More".

- [ ] **Step 7: Verify**

Run: `npx tsc --noEmit && npx vitest run && npx eslint && npm run build`

- [ ] **Step 8: Commit**

```bash
git add components app tests
git commit -m "feat: tick box for the whole charge, row menu for a partial"
```

---

### Task 10: The expense-report view

**Files:**
- Modify: `app/(app)/reimbursements/page.tsx` (replace contents entirely)
- Delete: `components/ClaimList.tsx`
- Test: covered by Task 3's `unreimbursedExpenses` tests; the page is assembly.

**Interfaces:**
- Consumes: `unreimbursedExpenses`, `owedToYou` from Tasks 2–3.

- [ ] **Step 1: Rewrite the page**

```typescript
import { createClient } from '@/lib/supabase/server'
import { PageHeader } from '@/components/ui/PageHeader'
import { Card } from '@/components/ui/Card'
import { money } from '@/lib/format'
import { unreimbursedExpenses, owedToYou, type DatedReimbursableTxn } from '@/lib/reimbursements'

export default async function ReimbursementsPage() {
  const supabase = await createClient()

  // Every marked row, both directions. No window: an expense from last year is still owed, and the
  // FIFO allocation needs the deposits that settled the older ones to be correct about the newer.
  const { data, error } = await supabase
    .from('transactions')
    .select('id, amount, date, name, merchant_name, user_category, reimbursable_amount, reimbursable_note')
    .not('reimbursable_amount', 'is', null)
    .eq('removed', false)
    .order('date', { ascending: false })

  // #46's lesson: a failed read must not render as "nothing outstanding".
  if (error) throw new Error(`could not read reimbursable transactions: ${error.message}`)

  const rows = (data ?? []) as (DatedReimbursableTxn & {
    name: string
    merchant_name: string | null
    user_category: string | null
    reimbursable_note: string | null
  })[]

  const outstanding = unreimbursedExpenses(rows)
  const byId = new Map(rows.map((r) => [r.id, r]))
  const owed = owedToYou(rows)

  return (
    <div className="space-y-6">
      <PageHeader
        title="Reimbursable"
        subtitle={
          owed > 0
            ? `You're owed ${money(owed)}. These are the expenses to put on your next report.`
            : 'Nothing outstanding. Tick a transaction as reimbursable and it will appear here.'
        }
      />
      <Card className="p-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left">
              <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-faint">Date</th>
              <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-faint">Merchant</th>
              <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-faint">Note</th>
              <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wide text-faint">
                Outstanding
              </th>
            </tr>
          </thead>
          <tbody>
            {outstanding.map((r) => {
              const t = byId.get(r.id)
              return (
                <tr key={r.id} className="border-b border-line">
                  <td className="px-4 py-3 whitespace-nowrap text-sm text-muted">{r.date}</td>
                  <td className="truncate px-4 py-3 font-medium text-ink">
                    {t?.merchant_name ?? t?.name ?? 'Transaction'}
                  </td>
                  <td className="truncate px-4 py-3 text-sm text-muted">{t?.reimbursable_note}</td>
                  <td className="px-4 py-3 text-right font-medium tabular-nums text-ink">
                    {money(r.remaining)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </Card>
    </div>
  )
}
```

`outstanding` is already oldest-first, which is the order an expense report wants. When it is empty, render the same empty-state Card the old page used rather than an empty table.

A second section below lists marked expenses the deposits HAVE covered, grouped by `date.slice(0, 7)`, so a past report can be reconstructed. Derive it as the marked outflows whose ids are absent from `outstanding` — do not re-run the allocation with different inputs, or the two lists can disagree about the same transaction.

- [ ] **Step 2: Update the nav label**

In `components/AppShell.tsx`, rename the `Reimbursements` nav item to `Reimbursable`.

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit && npx vitest run && npm run build`

- [ ] **Step 4: Commit**

```bash
git add app components
git commit -m "feat: expense-report view of what has not been paid back"
```

---

### Task 11: Delete the old model

**Files:**
- Delete: `app/api/reimbursements/claims/route.ts`, `app/api/reimbursements/splits/route.ts`, `components/SplitEditor.tsx`, `components/ReimbursableButton.tsx`, `lib/fast-path.ts`, `lib/split-validation.ts`, `tests/unit/fast-path.test.ts`, `tests/unit/split-validation.test.ts`, `tests/unit/claim-breakdown.test.ts`
- Modify: `lib/reimbursements.ts` (remove `claimTotals`, `allocateWriteOff`, `writeOffsAsTxns`, `reimbursedByTxn`, `receivableTotal`, and the `Claim`/`Split`/`WriteOff`/`WriteOffTxn`/`ClaimTotals`/`PersonTotal`/`UNATTRIBUTED` exports), `tests/unit/reimbursements.test.ts` (drop their tests)

- [ ] **Step 1: Delete, then let the compiler find the rest**

```bash
git rm app/api/reimbursements/claims/route.ts app/api/reimbursements/splits/route.ts \
       components/SplitEditor.tsx components/ReimbursableButton.tsx \
       lib/fast-path.ts lib/split-validation.ts \
       tests/unit/fast-path.test.ts tests/unit/split-validation.test.ts tests/unit/claim-breakdown.test.ts
npx tsc --noEmit
```

Fix every error it reports. **Do not delete a test merely because it fails to compile** — if it asserts money behaviour that still exists, port it to the new model. `tests/unit/reimbursement-reconciliation.test.ts` in particular must survive as a reconciliation test over the new column: the same fixture totalling 245 with marks applied and 470 without.

- [ ] **Step 2: Verify nothing references the dropped tables**

```bash
grep -rn "reimbursement_claims\|reimbursement_splits\|reimbursement_write_offs" app lib components
```

Expected: no matches outside `db/migrations/`.

- [ ] **Step 3: Full verification**

Run: `npx tsc --noEmit && npx vitest run && npx eslint && npm run build && npm run check:secrets`
Expected: all clean.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: delete claims, splits, write-offs and the fast path"
```

---

### Task 12: Drop the tables

**Files:**
- Create: `db/migrations/016_drop_reimbursement_tables.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Phase 9 (cont.): the old reimbursable model is unreferenced as of the previous commit. Dropped in
-- a SEPARATE migration from 015 so the column-adding step could be applied and verified while the
-- application still read the old tables — nothing is dropped until nothing reads it.
drop table if exists reimbursement_write_offs;
drop table if exists reimbursement_splits;
drop table if exists reimbursement_claims;
```

- [ ] **Step 2: Apply and verify the app still works**

Apply in the Supabase SQL editor, then load the dashboard, transactions, budgets, trends and the new Reimbursable page. Tick a transaction, confirm spending drops and net worth does not move, then untick it.

- [ ] **Step 3: Close the issues the model made moot**

```bash
gh issue close 44 --comment "Moot: reimbursable data now lives on the transaction itself, so there is no side table to cascade away. See docs/superpowers/specs/2026-08-31-reimbursable-simplification-design.md"
gh issue close 45 --comment "Moot: write-offs are deleted, so there are no write-off guards left to test."
gh issue close 46 --comment "Fixed by construction: the reads that replaced these now throw on error rather than rendering \$0 owed."
```

- [ ] **Step 4: Commit**

```bash
git add db/migrations/016_drop_reimbursement_tables.sql
git commit -m "db: drop the claims, splits and write-off tables"
```

---

## Final verification

- [ ] `npx vitest run` — all green, and the reconciliation test survives in ported form
- [ ] `npx tsc --noEmit`, `npx eslint`, `npm run build`, `npm run check:secrets`
- [ ] Manual: tick a work expense → spending drops, net worth unchanged, it appears on the Reimbursable page
- [ ] Manual: tick the matching deposit → it leaves the Reimbursable page, net worth still unchanged, income unaffected
- [ ] Manual: mark a partial via the row menu → the row shows "$750 of $1,000", spending drops by 750
- [ ] Manual: a credit-card payment offers no tick box
- [ ] Manual: re-run a Plaid sync and confirm marks survive it
