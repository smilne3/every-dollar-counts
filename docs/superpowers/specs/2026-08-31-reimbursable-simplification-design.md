# Reimbursable, Simplified — Design Spec

- **Repo:** `smilne3/every-dollar-counts`
- **Date:** 2026-08-31
- **Replaces:** #27 (reimbursable transactions, PR #40) and the fast path (PR #41). Closes PR #47.
- **Status:** Draft design, awaiting review
- **One line:** Reimbursable becomes a single tick box meaning *this dollar is not part of our picture* — in both directions — which deletes claims, people, write-offs and the chasing page while keeping net worth flat.

---

## 1. Why this exists

The reimbursable feature shipped a week ago and is over-engineered for the household using it. Its core assumption was that the app must know **which expense a given deposit pays back**. Claims, the person axis, per-claim outstanding, FIFO write-offs and the chasing page all descend from that one assumption.

Nobody checked it against the bank data first. Looking at the actual transactions:

> Work expense reimbursements arrive as **their own separate deposits**, never mixed into salary. A $480.25 deposit on 2026-08-18 is expenses coming back; the $2,772.63 on 2026-08-29 is a paycheck. They are never the same transaction.

Once reimbursements arrive separately, matching becomes unnecessary. A running total is enough:

```
outstanding = (ticked expenses) − (ticked deposits)
```

That produces the same flat net worth the current design produces, with no claims in existence.

**Chasing was also never wanted.** Both partners agreed that tracking down and re-settling an unpaid claim is their job, not the app's. The per-person breakdown, the days-outstanding counter and the write-off flow are answering a question nobody asked.

**Success looks like:** ticking one box takes a work expense out of spending; ticking the matching deposit takes it out of income; net worth never moves; and a single view lists what has not been paid back yet, for filling in an expense report.

## 2. The model

One boolean on a transaction. Ticked means **ignore this dollar** — it is money passing through on someone else's behalf, in whichever direction it happens to point.

| | Untouched | Ticked |
|---|---|---|
| **Outflow** (`amount > 0`) | ordinary spending | not spending; adds to what you are owed |
| **Inflow** (`amount < 0`) | ordinary income | not income; subtracts from what you are owed |

```
owedToYou = max(0, Σ ticked outflows − Σ ticked inflows)
netWorth  = accounts + manual assets + owedToYou
```

Salary is simply never ticked, so it stays income. This also dissolves a wart in the current UI: there is no longer any such thing as "splitting income" — the same tick box serves both directions, and the word "split" disappears from inflows entirely.

**Clamped at zero.** An over-repayment is a surplus inflow, not a debt you owe your employer, and must not quietly reduce net worth.

### 2.1 Why one flag can carry both directions

The sign of the transaction already says which direction the money is going. A separate "is this a repayment" field would be a second source of truth for something the amount already states, and could disagree with it. This mirrors the rule the current code already uses (`claimTotals` reads `txnAmount < 0` as a repayment) — it just stops being per-claim.

## 3. The expense-report view

Replaces the Reimbursements page, keeping its nav slot.

**What it answers:** which expenses have not been paid back yet, so they can be typed into an expense report.

**How it decides — FIFO on amounts, not dates.** Deposits settle the oldest outstanding expenses first. Anything the deposits have not covered is still unclaimed.

Date-based bucketing was considered and rejected. This household submits reports on no fixed rhythm ("we submit inconsistently, I can't predict that"), and any date rule loses money: submit on the 15th, get paid on the 20th, and an expense on the 17th falls *before* the last deposit. It would be filtered out as already-paid despite never having been claimed. Matching on amounts removes timing from the problem entirely.

The allocation is a pure function over ticked transactions — no stored state, nothing to keep in sync, and it recomputes correctly no matter what order things are ticked in.

**The view shows:** a running "you are owed $X" total, then the unreimbursed expenses oldest-first with date, merchant, category and amount. Already-covered expenses stay available below, grouped by month, so a past report can be reconstructed.

## 4. Data model

```sql
alter table transactions
  add column if not exists reimbursable boolean not null default false;

drop table if exists reimbursement_write_offs;
drop table if exists reimbursement_splits;
drop table if exists reimbursement_claims;
```

**The flag lives on `transactions`, and survives Plaid sync.** The sync upsert (`lib/ingest.ts:44`) lists only Plaid-derived columns, so `ON CONFLICT DO UPDATE` never touches columns absent from its payload. `user_category` has relied on exactly this since the app shipped; `reimbursable` inherits the same guarantee. **This must be asserted by a test**, since it is a property of the payload's shape rather than anything declared in the schema.

No new RLS policy is needed — `transactions` already carries household-scoped policies.

### 4.1 Migrating existing data

Production data must be inspected before anything is dropped. Three cases:

1. **Fully-split transactions** (split total == transaction amount) → set `reimbursable = true`. Behaviour is unchanged for them.
2. **Partially-split transactions** → **cannot be represented.** A flag is all-or-nothing. These must be listed for the user to decide, not silently rounded in either direction — rounding up overstates what is owed, rounding down invents spending.
3. **Write-offs** → these are frozen spending rows that currently appear in past months. Dropping the table removes that spending from history, changing closed months. If any exist, the user decides whether to accept the change or convert them to something that survives.

The migration is therefore **not** a blind `drop`. It reports first.

## 5. What gets deleted

| Area | Removed |
|---|---|
| Tables | `reimbursement_claims`, `reimbursement_splits`, `reimbursement_write_offs` |
| API | `app/api/reimbursements/claims/`, `app/api/reimbursements/splits/` |
| Lib | `lib/fast-path.ts`, `lib/split-validation.ts`, most of `lib/reimbursements.ts` |
| Components | `ClaimList`, `SplitEditor`, the Split affordance on the transaction row (pending open question 3) |
| Pages | the Reimbursements page (slot reused) |

`lib/spend-context.ts` shrinks rather than disappearing: the five money surfaces still need to agree about what is excluded, they just carry a set of ticked transaction ids instead of split totals and write-offs.

**What survives from PR #47:** the tick box UI and its column header, the `REIMBURSABLE` column, and the required-argument shape of `netWorth(accounts, receivable)` that makes a forgetful surface a type error.

## 6. Testing

- `spendableAmount` equivalent: a ticked transaction contributes 0 in either direction; an untouched one is returned unchanged.
- `owedToYou`: sums both directions, clamps at zero, ignores untouched rows.
- FIFO allocation: deposits settle oldest expenses first; a partially-covered expense reports its remainder; over-payment leaves nothing unclaimed.
- **Reconciliation:** the same fixture must total identically through the spending path and the net-worth path. The existing reconciliation test (245 with, 470 without) is the model — individually correct functions can still leak money between them, which is how #8 and #31 survived.
- **Sync preservation:** a re-sync of a modified transaction must leave `reimbursable` untouched.
- Net worth tile vs. its drill-down, as now.

## 7. Open questions

1. **A reimbursable expense that is never paid back.** `owedToYou` sits there forever, overstating net worth. Unticking fixes it but moves that spending back into an already-closed month — which the current design forbids on principle. Is that acceptable here? (The write-off machinery existed precisely to avoid it, and is being deleted.)
2. **Partly-reimbursable transactions** — a dinner covering both yourself and a client. A tick box cannot express it. Does this occur in practice, or are work expenses always the whole charge? This determines whether case 2 in §4.1 is a real migration problem or an empty set.
3. **Should the Split affordance survive at all** for non-reimbursable purposes (a holiday rental shared with friends)? The tables it needs are being dropped, so keeping it means keeping `reimbursement_splits`.

## 8. Risks

- **This is a deletion of ~2,000 lines of money code that is currently correct**, including six defects found by four reviewers pre-merge. Their fixes are being deleted along with the code that needed them; the new model must not silently reintroduce the same failures — particularly #31 (credit-card payments) and #8 (refunds as income), both of which are about a transaction being counted in the wrong direction.
- **Open issues #44 and #46** describe cascade-delete and unchecked-read paths that make a claim silently read as settled. Both become moot if claims cease to exist — worth confirming rather than assuming, and closing them explicitly if so. **#45** (route-handler tests for write-off guards) is moot once write-offs are deleted.
