# Reimbursable, Simplified — Design Spec

- **Repo:** `smilne3/every-dollar-counts`
- **Date:** 2026-08-31
- **Replaces:** #27 (reimbursable transactions, PR #40) and the fast path (PR #41). Closes PR #47.
- **Status:** Approved design, ready for implementation plan
- **One line:** Reimbursable becomes an *amount* on the transaction — a tick box for the whole charge, a note-bearing partial for the rest — which deletes claims, the person axis, write-offs, the chasing page and all three tables, while keeping net worth flat.

---

## 1. Why this exists

The reimbursable feature shipped a week ago and is over-engineered for the household using it. Its core assumption was that the app must know **which expense a given deposit pays back**. Claims, the person axis, per-claim outstanding, FIFO write-offs and the chasing page all descend from that one assumption.

Nobody checked it against the bank data first. Looking at the actual transactions:

> Work expense reimbursements arrive as **their own separate deposits**, never mixed into salary. A $480.25 deposit on 2026-08-18 is expenses coming back; the $2,772.63 on 2026-08-29 is a paycheck. They are never the same transaction.

Once reimbursements arrive separately, matching becomes unnecessary. A running total is enough:

```
outstanding = (reimbursable expenses) − (reimbursable deposits)
```

That produces the same flat net worth the current design produces, with no claims in existence.

**Chasing was also never wanted.** Both partners agreed that tracking down and re-settling an unpaid claim is their job, not the app's. The per-person breakdown, the days-outstanding counter and the write-off flow are answering a question nobody asked.

**Success looks like:** ticking one box takes a work expense out of spending; ticking the matching deposit takes it out of income; net worth never moves; and a single view lists what has not been paid back yet, for filling in an expense report.

## 2. The model

**One number on a transaction: how much of it is coming back.** Not mine, not spending, in whichever direction the transaction points.

| | Reimbursable amount 0 / null | Reimbursable amount set |
|---|---|---|
| **Outflow** (`amount > 0`) | ordinary spending | that much is not spending; adds to what you are owed |
| **Inflow** (`amount < 0`) | ordinary income | that much is not income; subtracts from what you are owed |

```
spendable  = sign(amount) × max(0, |amount| − reimbursable_amount)
owedToYou  = max(0, Σ reimbursable on outflows − Σ reimbursable on inflows)
netWorth   = accounts + manual assets + owedToYou
```

**The `spendable` rule is unchanged from the current implementation** — the same expression, reading a column instead of a sum over split rows. It is the single most load-bearing line in the feature and it does not move.

Salary is simply never marked, so it stays income. This also dissolves a wart in the current UI: there is no longer any such thing as "splitting income" — one control serves both directions and the word "split" leaves inflows entirely.

**Clamped at zero.** An over-repayment is a surplus inflow, not a debt you owe your employer, and must not quietly reduce net worth.

### 2.1 Two UIs, one concept

- **Tick box** (the common case): sets `reimbursable_amount` to the transaction's full amount. One tap, nothing typed.
- **Partial** (behind an overflow menu — see §3.1): sets a smaller amount, plus a free-text note. A $1,000 rental where friends owe $750 is `reimbursable_amount = 750, note = 'Dave, Sam, Priya'`.

The note is a **memo, not data**. Nothing computes over it. Per-person tracking was explicitly declined: the app records that $750 is coming back, not who owes which third. If Dave pays and Sam does not, the app knows $250 arrived and not from whom — that is the household's to hold, consistent with chasing being their job.

### 2.2 Why an amount rather than a boolean

A boolean cannot express the client dinner where half the table was yours, and cannot express the rental. Storing the amount also lets the database enforce what application code enforces today.

## 3. The expense-report view

Replaces the Reimbursements page, keeping its nav slot.

**What it answers:** which expenses have not been paid back yet, so they can be typed into an expense report.

**How it decides — FIFO on amounts, not dates.** Deposits settle the oldest outstanding expenses first. Anything the deposits have not covered is still unclaimed.

Date-based bucketing was considered and rejected. This household submits reports on no fixed rhythm ("we submit inconsistently, I can't predict that"), and any date rule loses money: submit on the 15th, get paid on the 20th, and an expense on the 17th falls *before* the last deposit. It would be filtered out as already-paid despite never having been claimed. Matching on amounts removes timing from the problem entirely.

The allocation is a pure function over the marked transactions — no stored state, nothing to keep in sync, and it recomputes correctly no matter what order things are marked in.

**The view shows:** a running "you are owed $X" total, then unreimbursed expenses oldest-first with date, merchant, category, amount and note. Already-covered expenses stay available below, grouped by month, so a past report can be reconstructed.

### 3.1 Transaction row layout

The row currently carries both a Reimbursable control and a Split link, which is cramped. Splitting is infrequent, so:

- **Reimbursable** keeps its own column and its tick box.
- **Split** moves into a vertical-three-dots overflow menu, along with any future per-row action.

This resolves the cramping structurally rather than by shaving column widths.

## 4. Data model

```sql
alter table transactions
  add column if not exists reimbursable_amount numeric,
  add column if not exists reimbursable_note text;

-- You cannot mark more as coming back than the transaction is worth. Enforced HERE rather than in
-- application code: today the equivalent rule lives in lib/split-validation.ts as a cross-row sum
-- check, which is correct but bypassable by any future writer that forgets to call it.
alter table transactions
  add constraint reimbursable_amount_within_transaction
  check (
    reimbursable_amount is null
    or (reimbursable_amount > 0 and reimbursable_amount <= abs(amount))
  );

drop table if exists reimbursement_write_offs;
drop table if exists reimbursement_splits;
drop table if exists reimbursement_claims;
```

**The columns live on `transactions`, and survive Plaid sync.** The sync upsert (`lib/ingest.ts:44`) lists only Plaid-derived columns, so `ON CONFLICT DO UPDATE` never touches columns absent from its payload. `user_category` has relied on exactly this since the app shipped. **This must be asserted by a test**, since it is a property of the payload's shape rather than anything declared in the schema — a future column added to that list would break it silently.

One consequence of the CHECK worth stating: if Plaid *modifies* a transaction's amount downward on a later sync, a previously valid `reimbursable_amount` could exceed it and the upsert would fail. The sync must handle that rather than crash — clamping to the new amount is the sensible answer, and it needs a test.

No new RLS policy is needed — `transactions` already carries household-scoped policies.

### 4.1 No migration — starting fresh

The feature shipped a week ago and **has not been used**: no claims, no splits, no write-offs worth
preserving. The tables are dropped outright and the columns start empty. There is deliberately no
conversion step, no reporting step, and no `owed_by` → note mapping to write.

One cheap guard survives that decision, because the cost of the assumption being wrong is silent
loss of real money records:

```sql
do $$
begin
  if exists (select 1 from reimbursement_splits limit 1)
     or exists (select 1 from reimbursement_write_offs limit 1) then
    raise exception
      'reimbursement data exists — this migration assumes a fresh start, see spec §4.1';
  end if;
end $$;
```

It costs three lines and turns a silent deletion into a loud stop. If it ever fires, the conversion
described in the previous draft of this spec is the starting point.

Because there is no data, the CHECK constraint in §4 can be created alongside the columns rather
than sequenced after a backfill.

## 5. What gets deleted

| Area | Removed |
|---|---|
| Tables | `reimbursement_claims`, `reimbursement_splits`, `reimbursement_write_offs` |
| API | `app/api/reimbursements/claims/`, `app/api/reimbursements/splits/` → one route that sets an amount + note |
| Lib | `lib/fast-path.ts`, `lib/split-validation.ts`, most of `lib/reimbursements.ts` |
| Components | `ClaimList`; `SplitEditor` shrinks to an amount + note and moves into the overflow menu |
| Pages | the Reimbursements page (slot reused for the expense-report view) |

`lib/spend-context.ts` shrinks rather than disappearing: the five money surfaces still need to agree about what is excluded, but they carry reimbursable amounts by transaction id instead of split totals plus write-offs.

**What survives from PR #47:** the tick box and its column header, and the required-argument shape of `netWorth(accounts, receivable)` that makes a forgetful surface a type error.

## 6. Testing

- `spendable`: a fully-marked transaction contributes 0 in either direction; a partial contributes the remainder with its sign intact; an unmarked one is returned unchanged.
- `owedToYou`: sums both directions, clamps at zero, ignores unmarked rows.
- FIFO allocation: deposits settle oldest expenses first; a partially-covered expense reports its remainder; over-payment leaves nothing unclaimed.
- **Reconciliation:** the same fixture must total identically through the spending path and the net-worth path. The existing reconciliation test (245 with, 470 without) is the model — individually correct functions can still leak money between them, which is how #8 and #31 survived.
- **Sync preservation:** a re-sync of a modified transaction leaves `reimbursable_amount` and the note untouched, and a downward amount change does not fail the CHECK.
- **Direction guards (amended post-implementation):** credit-card payments are refused at the route (`app/api/reimbursable/route.ts`), guarding #31. Transfers are deliberately **not** refused — this reverses the guard originally specified here. Plaid's `TRANSFER_OUT` category cannot distinguish an internal movement between the household's own accounts from a genuine loan to a person (a Zelle or Venmo to a friend who will repay), and the latter is exactly the case this feature exists for: a real receivable that should keep net worth flat. A blanket refusal would break that legitimate case in order to guard against the internal-transfer one, and there is no signal in the data to tell them apart. **Residual risk, stated plainly rather than left implicit:** marking an internal transfer as reimbursable inflates what the household is shown as owed until it is unticked — the guard here is user vigilance, not code. An unimplemented guard asserted in this document would be worse than this documented gap, because a future reader would trust it.
- Net worth tile vs. its drill-down, as now.

## 7. Open questions

None. All three raised in review are settled:

- **Partly-reimbursable transactions** — supported directly by the partial amount.
- **Split** — survives, behind an overflow menu, as an amount plus a note. No per-person lines.
- **An expense never paid back** — see §8.

## 8. Decision: giving up on an expense restores it to its original month

Clearing the amount restores that spending to **the month it happened in**, even if that month has
already been reviewed. Accepted explicitly by the household: *"None of our expenses are so big that
$75 really makes a big difference."*

The deleted write-off machinery booked the spending in the *write-off* month instead, specifically
to keep closed months immutable. That bought immutability at the cost of putting an expense in a
month it did not happen in — the right trade for a business with an accountant attached, and the
wrong one for two people reading their own budget. If the money never came back, it was spent when
it was spent.

## 9. Risks

- **This deletes ~2,000 lines of money code that is currently correct**, including fixes for six defects four reviewers found pre-merge. The new model must not silently reintroduce them — particularly #31 (credit-card payments) and #8 (refunds as income), both of which are about a transaction being counted in the wrong direction. The direction guards in §6 exist for this.
- **Open issues #44 and #46** describe cascade-delete and unchecked-read paths that make a claim silently read as settled. Both become moot once claims cease to exist, and the cascade concern disappears entirely because the data now lives on the transaction rather than in a table hanging off it. Confirm and close them explicitly rather than leaving them to rot. **#45** (route-handler tests for write-off guards) is moot once write-offs are deleted.
- **The tick box makes marking easy, which changes which cases are common.** Layout and performance assumptions made when splits were rare (per-row sub-lines, unbounded reads) should be re-checked against a world where many rows are marked.
