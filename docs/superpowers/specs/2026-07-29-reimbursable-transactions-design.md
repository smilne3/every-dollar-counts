# Reimbursable Transactions — Design Spec

- **Repo:** `smilne3/every-dollar-counts`
- **Date:** 2026-07-29
- **Issue:** #27
- **Status:** Approved design, ready for implementation plan
- **One line:** Let a transaction be marked fully or partly reimbursable, grouped under a named claim and attributed to the people who owe you, so the reimbursable money never counts as your spending and you can see at a glance who still hasn't paid you back.

---

## 1. Purpose

Money that passes through your account on someone else's behalf is not your spending. Today the app has no way to say so: a $1,000 vacation rental you split three ways lands as $1,000 of Travel spending, blows the budget, and distorts every trend that month.

Issue #27 asks for three things: mark expenses fully or partly reimbursable, describe what they're for ("bourbon trail trip"), and **visually track what has actually come back so you know whether to chase your employer or your friends.**

**Success looks like:** you front $1,000 for a rental, tag $250 each to Dave, Sam and Priya, and your spending shows $250 — your real share. The Reimbursements page shows $750 outstanding, and once Dave pays you it shows that Sam and Priya still owe $250 each.

## 2. What's already in place (shrinks the job)

- **A computed-spending seam already exists.** The refund fix (#8, commit `760e0bf`) established that a transaction's contribution to spending is derived, not simply `t.amount` — inflows in spending categories already net down. Reimbursables are a second instance of that idea, so they slot into a seam rather than cutting a new one.
- `effectiveCategory` and `isCreditCardPayment` are the established pattern: small pure helpers in `lib/` that every money surface routes through.
- `spendByCategory`, `spendThisVsLast` (`lib/budget.ts`) and `monthlyFlows` (`lib/dashboard.ts`) are pure and unit-tested — the three places spending is computed.
- `TransactionRow` + `CategoryPicker` already render and mutate a transaction inline.
- `ConfirmDialog` already guards destructive actions (commit `513c002`).
- The `categories` table (007) is the model for a household-owned, user-editable entity with RLS.

## 3. The four decisions this design rests on

These were settled during brainstorming and everything below follows from them.

### 3.1 Reimbursable money never counts as spending — starting immediately

The reimbursable portion is excluded from spending **the moment you mark it**, not when the money returns. The returning inflow is **flow-neutral**: not income, and not negative spending.

The rejected alternative was to count it as spending and net it out on repayment. That would rewrite a month after it closed — your July report would say something different in November. **No closed month's numbers ever change.** This principle is load-bearing; §3.3 exists to preserve it.

### 3.2 A claim is a real record, created on first use

Typing a new name in the split editor creates the claim inline — no separate "create a claim" step. But it is a real row, not a free-text tag, so it can carry status and totals. Free text would fragment ("bourbon trail" vs "Bourbon Trail Trip") and leave nowhere to record a write-off.

### 3.3 Writing off a claim creates spending in the month you write it off

When you give up on money, the unreturned amount becomes real spending — dated the day you wrote it off, in the categories it came from. Not in the original month (that would violate §3.1), and not nowhere (the money genuinely left your account).

### 3.4 Outstanding reimbursements do not count toward net worth

Net worth stays real account balances plus manually-entered assets. Fronting money for a work trip legitimately dips your net worth and recovers it when repaid; that reflects what you can actually spend. Outstanding amounts appear only on the Reimbursements page and one dashboard line.

## 4. Key decision: splits are a join table, with the person on the split

**Two independent axes.** A claim answers *what was this for* ("bourbon trail trip"). A split answers *whose share is this* ("Dave's $250"). Both are needed, and they are not the same axis.

The simpler model considered — a `claim_id` plus a single `reimbursable_amount` column on `transactions` — computes spending correctly for every scenario, including the partial case ($500 dinner, $400 back from work). **It fails the tracking requirement.** With one claim per transaction, a rental split three ways pools into "$750 owed, $250 back, $500 outstanding" with no way to see whose $500 that is. There is no workaround: three per-person claims can't all be tagged to one transaction. You cannot chase a pool, and #27 explicitly asks to chase people.

Putting `owed_by` on the split keeps both axes with one nullable column. Had it gone on the claim, an event with three debtors would fragment into three claims and lose the event grouping #27 asked for.

**The remainder is implicit.** Splits are what's owed to you; the unsplit remainder *is* your spending. There is no "my portion" field to keep in sync, so it can never disagree with the splits.

**The rejected third option** was synthetic offsetting transactions — inserting a −$750 row so the math needs no changes. It makes the transaction list stop matching your bank statement, which trades away the app's core credibility to save one helper function.

## 5. Data model (migration `012_reimbursements.sql`)

```sql
reimbursement_claims
  id           uuid pk
  household_id uuid not null references households(id) on delete cascade
  name         text not null
  written_off_on date                          -- null = open; set = written off
  created_at   timestamptz default now()
  unique (household_id, name)

reimbursement_splits
  id             uuid pk
  household_id   uuid not null references households(id) on delete cascade
  transaction_id uuid not null references transactions(id) on delete cascade
  claim_id       uuid not null references reimbursement_claims(id) on delete cascade
  owed_by        text                           -- nullable; the person axis
  amount         numeric not null check (amount > 0)
  created_at     timestamptz default now()
  -- indexed on transaction_id and on claim_id

reimbursement_write_offs
  id           uuid pk
  household_id uuid not null references households(id) on delete cascade
  claim_id     uuid not null references reimbursement_claims(id) on delete cascade
  category     text not null                    -- effective-category NAME, as budgets store it
  amount       numeric not null
  date         date not null                    -- the write-off date, not the expense date
  unique (claim_id, category)                   -- makes a retried write-off idempotent (see below)
```

All three get this repo's standard RLS policy — `household_id in (select private.household_ids())` for all operations — matching `011_manual_assets.sql`.

**A claim has no `status` column, deliberately.** There are only two stored states, and `written_off_on` already encodes both: null is open, set is written off. "Settled" is **derived** — a claim displays as settled when `outstanding <= 0`. Storing it as well would be two sources of truth for one fact, and they would drift the first time a split was edited. This also means there is no "Mark settled" action: full repayment settles a claim on its own, and settling for *less* than you're owed is exactly what Write off does.

**A split's meaning follows its transaction's sign** (Plaid: `amount > 0` is money out):

| Transaction | Split means | Effect on money math |
| --- | --- | --- |
| Outflow (`amount > 0`) | this much of the expense is owed back to you | reduces that transaction's spending contribution |
| Inflow (`amount < 0`) | this much of the deposit repays the claim | that portion is flow-neutral |

One symmetric table covers both directions, and a repayment that covers two claims is just two splits.

### Why write-offs are frozen rows

The write-off amount and its category allocation are computed **once**, when you click Write off, and stored. Deriving them on read would mean that editing or deleting a split on a written-off claim silently changes a month you already closed — reintroducing the retroactive rewrite §3.1 rules out.

Allocation is **pro-rata across the categories of that claim's expense splits**, by split amount. A vacation claim spanning Travel and Food & Drink writes off proportionally to each, so budgets and the per-category breakdown stay coherent. One row per category (typically 1–5 rows).

Writing off is two writes — insert the rows, then mark the claim — and they are not in one transaction. If the insert lands and the mark fails, the re-entry guard (which reads `written_off_on`) would let a retry through and insert a second set of rows, silently double-counting that claim's spending. The `unique (claim_id, category)` constraint plus an upsert closes this: a retry recomputes identical rows and overwrites them, so the operation converges no matter where it was interrupted.

## 6. The math layer

### New module `lib/reimbursements.ts` (pure, unit-tested)

- `reimbursedByTxn(splits): Record<string, number>` — split amounts summed per `transaction_id`.
- `spendableAmount(t, reimbursed): number` — **the single rule**, one expression covering both directions:

  ```ts
  sign(t.amount) * Math.max(0, Math.abs(t.amount) - reimbursed)
  ```

  Splits pull a transaction's contribution toward zero. A $1,000 outflow with $750 split contributes $250 of spending; a −$260 repayment with $250 split contributes −$10, so the $10 surplus stays an inflow and lands as income (§8). A transaction with no splits is returned untouched, which is what makes an empty split map a provable no-op.
- `claimTotals(claim, splits, txns)` → `{ owed, returned, outstanding, settled, byPerson[] }` — drives the Reimbursements page. `settled` is derived (`outstanding <= 0`), per §5.
- `allocateWriteOff(claim, splits, txns, onDate)` → the rows to freeze into `reimbursement_write_offs`.

### Modified

`spendByCategory`, `spendThisVsLast` (`lib/budget.ts`) and `monthlyFlows` (`lib/dashboard.ts`) call `spendableAmount(...)` instead of reading `t.amount`. Their `Txn` / `FlowTxn` types gain `id: string`.

**Write-offs need no changes inside those three functions.** A helper `writeOffsAsTxns(writeOffs)` maps stored write-off rows into in-memory transaction-shaped values (`user_category` = the stored category, `amount`, `date`), which pages concatenate onto their transaction list before the month filtering they already do. `effectiveCategory` honours `user_category` first, so each write-off lands in the right category by the existing path.

This is in-memory synthesis at read time, which is categorically different from the rejected option in §4 — nothing is written to `transactions`, so the user's ledger still matches their bank statement.

### Folded-in refactor: one `SpendContext`

Those three functions take 3–6 positional arguments today and would grow to 5–8. The shared inputs become one object, built once per page:

```ts
type SpendContext = {
  pfcMap: Record<string, string>
  nonSpending: Set<string>
  reimbursedByTxn: Record<string, number>
  writeOffs: WriteOff[]
}
```

This is worth doing *because* of the five call sites, not despite them. Dashboard, trends, budgets, breakdown and transactions each assemble these arguments by hand; a page that forgot to pass `reimbursedByTxn` would still compile and quietly report reimbursable money as spending. One context makes that drift a type error.

### Query changes

Every money read must now select the transaction `id` — `app/(app)/trends/page.tsx:27` and `app/(app)/dashboard/page.tsx:99` currently don't — and fetch the splits for the same date window in **one** query, building the map in memory. No per-transaction lookups.

## 7. Surfaces

### Create

- **`app/(app)/reimbursements/page.tsx`** — claims with owed / back / outstanding, the per-person rows, days since the oldest unpaid split, and the **Write off** action (guarded by `ConfirmDialog`, because it creates spending). Fully-repaid claims render as settled without any action being taken, per §5.
- **`components/SplitEditor.tsx`** — the inline editor, opened from a transaction row. Same component both directions; wording flips on the transaction's sign.
- **`components/ClaimList.tsx`** — presentational list for the Reimbursements page.
- **`app/api/reimbursements/splits/route.ts`** — create / update / delete splits (validates the cross-row sum, §8).
- **`app/api/reimbursements/claims/route.ts`** — create (inline, on first use), rename, write off, delete.
- **`lib/reimbursements.ts`** — §6.

### Modify

- **`components/TransactionRow.tsx`** — a "Split" affordance; when open, `SplitEditor` renders beneath the row. Rows with splits show a quiet marker and their reduced share.
- **`components/AppShell.tsx`** — a sixth nav item, `/reimbursements` (`AppShell.tsx:24-29`).
- **`app/(app)/dashboard/page.tsx`** — one compact "Owed to you: $540" line linking to the page, rendered **only when something is outstanding**. Zero footprint until you have a claim; discoverable the moment you do.
- **The five money surfaces** — build a `SpendContext` and pass it.

**Budgets, trends and breakdown need no new UI.** They inherit correct numbers from the math layer.

### The split editor

```
Vacation rental  ·  Airbnb  ·  $1,000.00              [Split ▾]
├─ Claim:  Vacation rental ▾           (type to create)
├─ Dave     $250.00   ✕
├─ Sam      $250.00   ✕
├─ Priya    $250.00   ✕
├─ + Add person
└─ Your share: $250.00        ← live: amount − splits
```

The live "your share" readout is the point of the layout: you see the number that will hit your budget while editing, not after saving. `owed_by` is free text with a `datalist` of names used before, to curb typos without imposing a contacts model.

## 8. Edge cases

- **Splits exceed the transaction amount** → rejected by the API. A per-row `check (amount > 0)` cannot see sibling rows, so the cross-row sum is validated server-side on every write, against both `abs(transaction.amount)` and — for a repayment — the claim's current outstanding.
- **Overpayment** — Dave rounds $250 up to $260. You tag $250 against the claim (the API won't accept a repayment split above outstanding), and the extra $10 is simply **left unsplit**, so it is treated exactly as an untagged $10 inflow of that category would be: income in an income category, or a refund netting that category down in a spending category. No capping logic is needed in the math layer. This is the same "the remainder is implicit" property as §4, running in the other direction.
- **Money arrives after a write-off** → the claim is closed and stays closed; that inflow is ordinary income. Reopening is out of scope.
- **Transaction hard-deleted** → splits cascade via FK; claim totals recompute from what remains. Frozen write-off rows are unaffected by design (§5).
- **Transaction `removed = true`** → this is a *soft* flag, not a delete (`lib/ingest.ts`'s Plaid-repost path does `.update({ removed: true })`; the row is never deleted). The FK cascade above does **not** fire — no app path performs a genuine hard delete on a transaction today, so that cascade exists only in theory. Instead, every read that feeds claim totals or write-off allocation filters `.eq('removed', false)`, so a removed transaction's amount is absent from the amount map the read builds; `claimTotals`' `txnAmount === undefined` guard (`lib/reimbursements.ts`) then skips any split still pointing at it, which is what actually makes totals "recompute from what remains" for this case. Frozen write-off rows are unaffected by design (§5), same as a hard delete.
- **Deleting an OPEN claim** → `ConfirmDialog`, then cascade. Its splits go, and the money they were excluding counts as spending again in the months it happened — correct, because an open claim's exclusions were always provisional.
- **Deleting a WRITTEN-OFF claim** → refused by the API (400), and the UI does not offer the action.

  An earlier draft of this section said both "frozen write-off rows are unaffected by design" and "deleting a claim → cascade". Those cannot both hold: `reimbursement_write_offs.claim_id` cascades, so deleting a written-off claim would wipe its frozen rows *and* un-exclude its original splits — rewriting a month that had already closed, which is exactly what §3.1 forbids. The invariant wins. A written-off claim is a permanent record of spending that has already counted.

  The accepted cost: a write-off made in error cannot be undone, since reopening a written-off claim is also out of scope (§8, above). If that proves painful in practice, the fix is a deliberate "reverse a write-off" action that posts a compensating entry in the *current* month — not a deletion that edits the past.
- **A claim whose splits span several categories** → write-off allocates pro-rata (§5).
- **A claim with `owed_by` left blank** → allowed; it groups under "Unattributed" on the claim's per-person list.
- **`plaid_env` (#23)** → the new queries are scoped exactly like the existing money reads. This feature must not widen that open bug.

## 9. Testing

- **`lib/reimbursements.ts`** carries the load, being pure: `spendableAmount` across outflow fully / partly / not reimbursable, a repayment inflow with and without splits, and a partly-tagged inflow (the $260/$250 surplus case) asserting the residual $10 stays an inflow; `claimTotals` for the per-person breakdown, a partly-repaid claim, a derived-settled claim and a written-off one; `allocateWriteOff` for single- and multi-category claims.
- **The split-sum validation** is server-side, so it gets its own tests: a split pushing the total past the transaction amount is rejected, and a repayment split above the claim's outstanding is rejected.
- **Existing suites must keep passing unchanged.** `budget.test.ts` and `dashboard.test.ts` gain reimbursable cases, and an empty split map must be a provable no-op.
- **A reconciliation property test:** for any fixture, `total spending == Σ outflows − Σ reimbursable splits + Σ write-offs`. Every function can look right in isolation while money leaks between them — that is how #8 and #31 survived. This is the test that catches what per-function tests cannot.
- **RLS** — `tests/rls/` is currently empty, so the policies on all three new tables are verified manually: a second household can neither read nor write another's claims, splits or write-offs.
- Pages and API routes are covered by `tsc` / lint / build plus a manual pass: split a rental three ways, confirm spending drops to your share, tag a repayment, confirm the person shows paid, then write off the rest and confirm it lands in the current month.

## 10. Out of scope

- Auto-suggesting which claim an incoming deposit belongs to (#27 accepts manual linking).
- Percentage or recurring splits ("40% of my phone bill is work").
- Splitting one transaction's *remainder* across multiple categories.
- Reopening a written-off claim.
- A contacts model for `owed_by` — free text with autocomplete only.
- Multi-currency.
- Counting outstanding reimbursements as a net-worth receivable (§3.4).
- Closing #23 — this feature is built not to worsen it.
