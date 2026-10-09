# Category Learning, PR 2: Rules, Read-Time Resolution, Settings — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the household merchant rules that relabel every matching transaction at read time, never by writing `user_category`, and make every money page, count and filter resolve categories through one function, so a rule can move a dollar between categories but never into or out of Spent, Income or Saved.

**Architecture:** A new table, `category_rules`, holds one rule per merchant per household (migration 021, hand-run). `lib/category-rules.ts` is pure: it builds branded contexts from the categories and rules, and `resolveCategory` is the only code that turns a row into a category name (pick, then rule, then bank). `lib/category-context.ts` is the one server read of categories and rules, and it throws. Every money page, the transactions filters, Settings' counts and the delete-category dialog go through these. Settings gains a Category rules card (Change, Remove) backed by a new environment-guarded route. A rule's effect exists only at read time, so nothing on `transactions` changes and ingest is untouched. Learning from a pick is PR 3; in this PR rules come only from the one-time seed.

**Tech Stack:** Next.js 16 App Router (Server Components, route handlers), Supabase (`@supabase/ssr` server client, RLS), React 19 client components, Tailwind v4, Vitest + Testing Library (jsdom). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-11-category-rules-design.md` on branch `28-category-rules`, approved 2026-10-07. Read its "Changes since 2026-09-11" note first. This plan implements PR 2 of §10.1: migration 021 and the three `db/seeds/` files; the rest of §5; §6.2; §6.3's DELETE guard; §7 including tripwire 4; §8.1's marker and the `category: ResolvedCategory` prop; §8.2's `source:value` key; §8.3; §8.4; README; and every §11 test not marked PR 1 or PR 3. The spec's line numbers date from 2026-09-11; where this plan quotes code, the plan is current.

**Prerequisite owned by the owner, not by any task:** migration 021 must be applied to the shared database before the PR 2 pages can load locally or on a Preview (spec §10.2 step 2). As of 2026-10-08 it is **not** applied (`PGRST205 Could not find the table 'public.category_rules'`). Unit tests do not need it. Task 1 writes the file; the owner runs it in the SQL editor and confirms the grants. To review the marker and Settings on a Preview, run the seed there and reset afterwards (§9).

## Global Constraints

- **Rules never write `user_category`** (spec decision 2). Ingest (`lib/ingest.ts`) is not touched. No column is added to `transactions`.
- **One function decides a category:** `resolveCategory(t, ctx)`. Precedence is pick → rule → bank. Card payments (`isCardPaymentRow(pfc_detailed)`, never `isCreditCardPayment`) never take a rule. A rule applies only when its category's kind equals **both** `bankCategory(t).kind` and `kindOf(bankCategory(t).name)`.
- **Merchant key:** `merchantKey(s)` is `null` for null, `''` or whitespace; otherwise `s.trim().toLowerCase()`. Exact match only: `Walmart+` is not `walmart`.
- **Branded contexts.** `CategoryData`, `KindContext`, `CategoryContext` (and `SpendContext`, which is a `CategoryContext`) are built only by their producers. `as CategoryData`, `as KindContext`, `as CategoryContext`, `as SpendContext` appear only in `lib/category-rules.ts`, `lib/category-context.ts`, `lib/spend-context.ts` and `tests/unit/helpers/`.
- **Failed reads are never "no data"** (#46). Every money page throws when categories or rules fail to load. Settings alone catches, and shows `Couldn't load categories and rules. Try again.` with Banks still usable (spec §7.3).
- **Every write is narrowed** with `{ count: 'exact' }`, and a falsy count is never reported as success.
- **The database's words are logged, never shown.** Every message a person can see is written English, copied exactly from this plan.
- **A save counts only when** `res.ok && !res.redirected` and the body is JSON with `ok: true` (spec §8.2). A redirect, or an OK reply that isn't JSON, shows `Your session ended. Sign in again.`
- **Rule writes and category deletes are environment-guarded** (`assertEnvMatchesDatabase` through `envGuardResponse`), so local and Preview sessions can't change production rules.
- **Never drop, truncate or empty `category_rules`** while any build from this PR is live. The seed runs once on production, immediately before deploy.
- **Desktop rows:** the learned marker never adds a line and never moves the select. Only a save error grows a row (PR 1's accepted departure; see Ruling 1).
- **No new dependencies.** Run the suite in both timezones before the PR: `npx vitest run` and `VITEST_TZ=America/Los_Angeles npx vitest run`. Also `npx tsc --noEmit`, `npm run lint`, `npm run check:invariants`, `npm run check:secrets`, `npx next build`.
- **Every guard added gets a mutation check** before the PR: revert it, see a named test fail, restore. Task 12 lists them.
- **Out-of-scope findings become GitHub issues** (`.claude/rules/filing-issues.md`), never fixes on this branch.

## Rulings this plan makes (from PR 1)

These settle the five points the owner raised. Each is binding on the task that owns it.

1. **"One no-wrap line" vs PR 1's in-flow error (spec §8.1, §8.2, §11).** PR 1 shipped, and the owner accepted, a save error that shows *under* the select and grows that one desktop row until the next pick or refresh. Every layout that avoided growth hid, overlapped or clipped the message. So the spec's "one no-wrap line" is read **horizontally**: the Category cell is a `flex flex-nowrap items-start` row whose only children are the picker's container and, when a rule changed the name, the marker. The marker never wraps under the select, never moves it, and adds no height. The select still sets the row's height in every state **except** while a save error shows, when the picker's own column grows by the alert, exactly as in PR 1. `items-start` keeps the marker beside the select instead of centring it on the grown cell. Task 10's tests assert this shape; §11's "no block element" becomes "the cell's direct children are the picker container and the marker, and nothing else".
2. **The marker beside a picker that fills the cell (#138).** The picker's container becomes `min-w-0 flex-1`, so the select fills whatever the marker leaves. The marker is a `shrink-0` link wrapping a 14px icon, `h-[34px]` so it centres on the desktop select (select: `py-1.5` + a 20px line + 2px border = 34px; Task 10 measures it in Chromium). In the 160px column (128px of content) the select keeps about 102px on a learned row. Long names already clip in a closed select; that is #138's known residue, unchanged.
3. **Paging.** Transactions read through `lib/read-all.ts`'s `readAllRows` (from #131), so `readTransactionsForCounts` selects `date`. `category_rules` has no `date`, so Task 2 adds `readAllById` to `lib/read-all.ts`. The spec's separate `readAllByKeyset` helper is not created. `readAllById` owns its `.order('id')`, as `readAllRows` owns `date, id`.
4. **Settings' budgets read** (#91) is checked in Task 7 and joins the categories/rules/transactions reads inside Settings' one `try`. Settings' transactions read moves into `readTransactionsForCounts`.
5. **TransactionCard** gets the same `category: ResolvedCategory` prop and the same marker, adapted to the phone (Task 10). Its meta line sits inside a `<button>`, where a link is invalid HTML, so there the marker is an icon only and the button's `aria-label` says "learned from {merchant}". The sheet shows the icon, "Learned from {merchant}." and a "Manage in Settings" link under the picker.

Two smaller departures from the spec's letter, taken because the spec's own shape doesn't fit the code as it now stands:
- **`categoryUsage(rows, data, budgetNames)`** takes `CategoryData`, not a context, because the per-rule counts need each rule's merchant key and a context deliberately hides its rules. It builds the context itself. It also returns `matching` per rule, which "No current transactions" needs.
- **`TXN_READS_ALLOWED`'s stale Settings entry** (spec §7.4) no longer exists; #131 removed it. Nothing to do.

## Review Focus

The five inputs most likely to bite the household that no spec-listed test pins. Each has its test added to the owning task.

1. **A category renamed after a rule points at it.** The rule follows the id, so every Safeway row shows the new name at once; the stale name must never appear. *(Task 3: "follows a renamed category".)*
2. **A learned row whose save fails on desktop.** The alert appears under the select, the marker stays beside the select at the top of the cell, and nothing else in the row moves. *(Task 10: "keeps the marker beside the select while an error shows".)*
3. **Picking a category by hand on a learned row.** After the refresh the source is `pick`: the marker disappears on both surfaces and the picker's pending value and alert reset. *(Task 10: "a hand pick shows no marker" on row and card; Task 10 picker source test.)*
4. **The Category rules list on a phone.** A long merchant truncates with its full name in `title`; the count never truncates; the row stacks below `sm`, so nothing is wider than 390px. *(Task 9: "stacks below sm and never truncates the count".)*
5. **Deleting a category that only rules file into.** Its rule-labelled rows go back to their bank category, not to Uncategorized, and the dialog says so. *(Task 7: "counts rule-labelled rows as moving to their bank category".)*

---

## File Structure

| File | Change | Responsibility |
| --- | --- | --- |
| `db/migrations/021_category_rules.sql` | Create | The table, its RLS and grants (spec §4). |
| `db/seeds/021_category_rules_seed.sql`, `_dry_run.sql`, `_checks.sql` | Create | One-time seed, its expected set, and the launch checks (spec §9, §10.2). |
| `README.md` | Modify | Run order gains `021`; one line pointing at the seed header. |
| `lib/read-all.ts` | Modify | Add `readAllById` and `IdPageableQuery`. |
| `tests/stubs/postgrest-pages.ts` | Modify | Add `idPagedTable` and `ruleRows`. |
| `lib/category-rules.ts` | Create | Types, brands, `merchantKey`, `kindOf`, `bankCategory`, the two context builders, `resolveCategory`, `changedByRule`. Pure. |
| `tests/unit/helpers/category-context.ts` | Create | Test-only builders (the one place outside `lib/` that casts a brand). |
| `lib/category-context.ts` | Create | `fetchCategoryContext` (cached, throws) and `readTransactionsForCounts`. Server-only. |
| `lib/spend-context.ts`, `lib/effective-category.ts`, `lib/budget.ts`, `lib/dashboard.ts` | Modify | Money layer on the context; `Txn`/`FlowTxn` gain `merchant_name`. |
| `lib/category-views.ts` | Create | `filterByCategory`, `filterByFlow`, `activityItem`, `categoryUsage`, `deleteImpact`. Pure. |
| Six pages under `app/(app)/` | Modify | Read through `fetchCategoryContext`; filters and counts from `lib/category-views.ts`. |
| `app/api/category-rules/route.ts` | Create | PATCH (Change) and DELETE (Remove). |
| `app/api/categories/route.ts` | Modify | DELETE becomes environment-guarded. |
| `lib/save-response.ts` | Create | The §8.2 success rule, for the rules card. |
| `components/CategoryRulesCard.tsx` | Create | Settings → Category rules. |
| `components/CategoryManager.tsx` | Modify | Delete dialog shows `deleteImpact`. |
| `components/LearnedMarker.tsx`, `components/ui/icons.tsx` | Create / Modify | The marker link and `LearnedIcon`. |
| `components/CategoryPicker.tsx`, `TransactionRow.tsx`, `TransactionCard.tsx` | Modify | `source` key; `category: ResolvedCategory` prop; marker. |
| `scripts/check-invariants.mjs` | Modify | Exported pure checks; tripwire 4. |
| Tests under `tests/unit/` | Create / Modify | Listed per task. |

---

### Task 1: Migration 021 and the seed files

**Files:**
- Create: `db/migrations/021_category_rules.sql`
- Create: `db/seeds/021_category_rules_seed.sql`, `db/seeds/021_category_rules_dry_run.sql`, `db/seeds/021_category_rules_checks.sql`
- Modify: `README.md` (the run-order line under "### 2. Create the database tables")

**Interfaces:**
- Produces: table `public.category_rules (id, household_id, merchant_key, merchant_label, category_id, origin, created_at, updated_at)`, unique `(household_id, merchant_key)`, composite FK `(household_id, category_id) → categories (household_id, id) on delete cascade`. Every later task reads these column names.

SQL can't be unit tested here. The deliverable is reviewed against spec §4 and §9 line by line, and the owner applies it.

- [ ] **Step 1: Check the columns the seed joins on exist.** Run `grep -n "account_id\|plaid_item_id" db/migrations/002_plaid_items_accounts.sql db/migrations/003_transactions.sql` and `grep -n "plaid_env" db/migrations/010_plaid_production.sql db/migrations/017_app_env.sql`. Expected: `accounts.account_id`, `accounts.plaid_item_id`, `transactions.account_id`, `plaid_items.plaid_env`, `app_env.plaid_env` all exist. If any does not, stop and report; do not adapt the SQL.

- [ ] **Step 2: Write `db/migrations/021_category_rules.sql`.**

```sql
-- Category rules (#28): one rule per merchant per household, learned from a hand pick or seeded
-- once from the household's existing picks. A rule's effect exists only at READ time
-- (lib/category-rules.ts resolveCategory): nothing on transactions is written, so changing or
-- removing a rule moves every row with it and a rollback is a code revert.
--
-- Hand-run in the SQL editor and safe to re-run. It creates NO rows: seeding is
-- db/seeds/021_category_rules_seed.sql, run once on production immediately before the PR 2 deploy.
--
-- NEVER drop or empty category_rules while any deployment built from PR 2 or later is live,
-- production or Preview. One database serves local, Preview and production (017_app_env.sql), and
-- five money pages and Settings read this table on every load.

-- 1) FK target: (household_id, id) on categories. id is already the primary key (007), so this
--    cannot fail.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'categories_household_id_id_key') then
    alter table public.categories
      add constraint categories_household_id_id_key unique (household_id, id);
  end if;
end $$;

-- 2) Table and its security in ONE statement, so the table never exists without RLS.
--    The category is referenced by id, not by name (unlike 007's convention): renames need no
--    cascade, deleting a category deletes its rules in the same statement, a re-added category
--    can't inherit a rule, and the composite FK stops a rule pointing into another household
--    (Postgres runs FK checks outside RLS). No FK to transactions, accounts or plaid_items:
--    rules must survive a bank being disconnected and relinked.
do $$ begin
  if to_regclass('public.category_rules') is null then
    create table public.category_rules (
      id uuid primary key default gen_random_uuid(),
      household_id uuid not null references public.households(id) on delete cascade,
      merchant_key text not null check (merchant_key <> ''),   -- lower(trim(merchant_name))
      merchant_label text not null,                            -- display spelling
      category_id uuid not null,
      origin text not null check (origin in ('seeded', 'learned')),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      constraint category_rules_one_per_merchant unique (household_id, merchant_key),
      constraint category_rules_category_fk foreign key (household_id, category_id)
        references public.categories (household_id, id) on delete cascade
    );
    alter table public.category_rules enable row level security;
    create policy "manage your category rules" on public.category_rules
      for all to authenticated
      using ( household_id in (select private.household_ids()) )
      with check ( household_id in (select private.household_ids()) );
  end if;
end $$;

-- 3) Idempotent re-asserts for a re-run (the 007 pattern).
alter table public.category_rules enable row level security;
drop policy if exists "manage your category rules" on public.category_rules;
create policy "manage your category rules" on public.category_rules
  for all to authenticated
  using ( household_id in (select private.household_ids()) )
  with check ( household_id in (select private.household_ids()) );

-- 4) Explicit grants. No anon grant. Supabase is ending its default of granting new public tables
--    to the API roles; without these the app gets 42501 permission denied although RLS and the
--    policy look correct, while the seed (run as postgres) still succeeds.
grant select, insert, update, delete on table public.category_rules to authenticated;
grant select, insert, update, delete on table public.category_rules to service_role;

-- Check after running (each must be true):
--   select has_table_privilege('authenticated', 'public.category_rules', 'SELECT'),
--          has_table_privilege('authenticated', 'public.category_rules', 'INSERT'),
--          has_table_privilege('authenticated', 'public.category_rules', 'UPDATE'),
--          has_table_privilege('authenticated', 'public.category_rules', 'DELETE');
--
-- Rollback, only once no deployment built from PR 2 is live: drop category_rules first, then the
-- categories_household_id_id_key constraint its FK depends on.
```

- [ ] **Step 3: Write `db/seeds/021_category_rules_seed.sql`.** Copy spec §9's seed block verbatim, including its four-line header comment, then add this paragraph to the top of the header:

```sql
-- Seeds category_rules from the household's existing hand picks (#28 spec §9). A merchant gets a
-- rule when every eligible pick on it names the same category. A pick is eligible when its row is
-- from the live environment, not removed, not a card payment, and has a merchant_name; its category
-- still exists; it doesn't cross between spending, transfers and income (the same two-kind gate as
-- lib/category-rules.ts resolveCategory); and it isn't the row's bank category.
--
-- Run order, immediately before PR 2 deploys (spec §10.2 step 3): back up hand picks, run
-- 021_category_rules_checks.sql's pre-seed checks, run 021_category_rules_dry_run.sql, run this,
-- then the checks file's diff and verification queries.
--
-- Reset, ONLY before PR 2 deploys: delete from public.category_rules where origin = 'seeded';
-- then run this again. After PR 2 deploys there is no reset; changes go through Settings.
```

- [ ] **Step 4: Write `db/seeds/021_category_rules_dry_run.sql`.** A header (`-- Read-only. The rules 021_category_rules_seed.sql would create: run it immediately before the seed and keep the result.`) followed by spec §9's `with cats as (…), picks as (…), eligible as (…) select … from eligible group by household_id, merchant_key having count(distinct category_id) = 1` exactly as in the seed: no `insert`, no `on conflict`, no `do $$` block. Alias the output columns `household_id, merchant_key, merchant_label, category_id, origin` (the `mode()` column as `merchant_label`, the `array_agg` column as `category_id`, `'seeded'` as `origin`) so the diff below can compare by name.

- [ ] **Step 5: Write `db/seeds/021_category_rules_checks.sql`.** Read-only queries, each under a comment naming its §10.2 step and its expected result:

```sql
-- Launch checks for category rules (#28 spec §10.2). Every query here is read-only.

-- 3a. ASCII: the seed's key matches lib/category-rules.ts merchantKey only on ASCII. Expect 0.
select count(distinct merchant_name) from public.transactions where merchant_name ~ '[^ -~]';

-- 3b. Defaults. Expect no rows. Then review any INCOME / TRANSFER_* primary in the second query
--     with the owner: those rows take no rule (spec §5.2).
select p from unnest(array['INCOME','TRANSFER_IN','TRANSFER_OUT']) p
where not exists (select 1 from public.categories c where c.pfc_primary = p);

select t.pfc_primary, count(*) from public.transactions t
where t.removed = false
  and not exists (select 1 from public.categories c
                  where c.household_id = t.household_id and c.pfc_primary = t.pfc_primary)
group by 1 order by 2 desc;

-- 3c. Budgets. If any exist, those bars and the dashboard footnote move at deploy, by design.
select category from public.budgets;

-- 3d. Card payments carrying a pick or a mark. Expect 0 rows.
select id, merchant_name, date, user_category, reimbursable_amount from public.transactions
where removed = false and pfc_detailed = 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT'
  and (user_category is not null or reimbursable_amount is not null);

-- 3e. Seed diff, after running the seed. Both sides must return 0 rows.
--     (Paste 021_category_rules_dry_run.sql's query as the body of `expected`.)
with expected as (
  -- 021_category_rules_dry_run.sql
  select null::uuid as household_id, null::text as merchant_key, null::text as merchant_label,
         null::uuid as category_id, null::text as origin where false
), actual as (
  select household_id, merchant_key, merchant_label, category_id, origin from public.category_rules
)
select 'expected but missing' as side, * from (select * from expected except select * from actual) a
union all
select 'present but not expected', * from (select * from actual except select * from expected) b;

-- 3f. Per-rule verification (spec §9). No environment filter, because pages have none.
<spec §9's verification query, verbatim>

-- 3g. Fingerprint of the rows the totals read (spec §10.2 step 3). Replace the date.
select count(*), md5(string_agg(id::text || ':' || amount || ':' || coalesce(user_category,'') || ':' ||
       coalesce(pfc_primary,'') || ':' || coalesce(pfc_detailed,'') || ':' || coalesce(merchant_name,'') || ':' ||
       coalesce(reimbursable_amount::text,''), ',' order by id))
from public.transactions where removed = false and date >= '<six-month window start>';
```

In 3e, replace the placeholder `select … where false` body with the dry run's query itself (copied, not referenced), so the file runs as-is. In 3f, paste spec §9's verification query in full. The only text left for the operator to fill is 3g's date, which the comment names.

- [ ] **Step 6: README.** In `README.md`, change the run-order line to end `… → 018 → 019 → 020 → 021` (keep the "there is no 005" note), and add directly after the "Each run should end with" paragraph:

```markdown
`db/seeds/` is **not** part of setup. It holds one-time production scripts; read the header of `db/seeds/021_category_rules_seed.sql` before running anything there.
```

- [ ] **Step 7: Self-check.** `diff <(sed -n '/^do \$\$ begin$/,/^end \$\$;$/p' db/seeds/021_category_rules_seed.sql) <(git show 28-category-rules:docs/superpowers/specs/2026-09-11-category-rules-design.md | sed -n '/^-- NOT PART OF SETUP/,/^end \$\$;$/p' | sed -n '/^do \$\$ begin$/,$p')` prints nothing. If it prints a difference, make the file match the spec.

- [ ] **Step 8: Commit.**

```bash
git add db/migrations/021_category_rules.sql db/seeds README.md
git commit -m "Add migration 021 and the one-time category-rules seed (#28)"
```

---

### Task 2: `readAllById`

**Files:**
- Modify: `lib/read-all.ts`
- Modify: `tests/stubs/postgrest-pages.ts`
- Test: `tests/unit/read-all.test.ts`

**Interfaces:**
- Produces: `export interface IdPageableQuery<T>`, `export async function readAllById<T extends { id: string }>(build: () => IdPageableQuery<T>): Promise<{ data: T[]; error: null } | { data: null; error: { message: string; code?: string } }>`. Task 4 uses it for `category_rules`.
- Produces (tests): `idPagedTable(rows, opts)` and `ruleRows(n)` in `tests/stubs/postgrest-pages.ts`. Task 4 uses both.

- [ ] **Step 1: Add the stub.** Append to `tests/stubs/postgrest-pages.ts`:

```ts
// The same stand-in for a table with no `date`, read by lib/read-all.ts's readAllById, which pages
// on `id` alone: `.order('id')`, then `.gt('id', last)` from the second page on. Rows come back in
// id order only when ordered by id; otherwise in an arbitrary (reversed) order, as Postgres may.
export type IdPagedTable = {
  requests: { after: string | null; limit: number | null; ordered: boolean }[]
  query: () => Record<string, unknown>
}

export function idPagedTable<R extends { id: string }>(
  rows: R[],
  opts: { serverCap?: number; failOnRequest?: number; emptyBodyOnRequest?: number } = {}
): IdPagedTable {
  const cap = opts.serverCap ?? 1000
  const requests: IdPagedTable['requests'] = []

  const query = () => {
    let after: string | null = null
    let limit: number | null = null
    let ordered = false
    const chain: Record<string, unknown> = {}
    for (const m of ['select', 'eq']) chain[m] = () => chain
    chain.order = (col: string) => {
      if (col !== 'id') throw new Error(`unexpected .order(): ${col}`)
      ordered = true
      return chain
    }
    chain.gt = (col: string, value: string) => {
      if (col !== 'id') throw new Error(`unexpected .gt(): ${col}`)
      after = value
      return chain
    }
    chain.limit = (n: number) => {
      limit = n
      return chain
    }
    chain.then = (resolve: (r: unknown) => unknown) => {
      requests.push({ after, limit, ordered })
      const n = requests.length
      if (opts.failOnRequest === n) {
        return Promise.resolve({ data: null, error: { message: 'boom', code: 'XX000' } }).then(resolve)
      }
      if (opts.emptyBodyOnRequest === n) {
        return Promise.resolve({ data: null, error: null }).then(resolve)
      }
      const sorted = ordered ? [...rows].sort((x, y) => (x.id < y.id ? -1 : 1)) : [...rows].reverse()
      const a = after
      const rest = a === null ? sorted : sorted.filter((r) => r.id > a)
      return Promise.resolve({ data: rest.slice(0, Math.min(limit ?? cap, cap)), error: null }).then(resolve)
    }
    return chain
  }

  return { requests, query }
}

// `n` category_rules rows with sortable ids, all in one household.
export function ruleRows(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `r${String(i).padStart(5, '0')}`,
    household_id: 'hh-1',
    merchant_key: `merchant ${i}`,
    merchant_label: `Merchant ${i}`,
    category_id: 'c-grocery',
    origin: 'seeded' as const,
  }))
}
```

- [ ] **Step 2: Write the failing tests.** Append to `tests/unit/read-all.test.ts` (merge imports):

```ts
import { readAllById, type IdPageableQuery } from '@/lib/read-all'
import { idPagedTable, ruleRows } from '../stubs/postgrest-pages'

type RuleRow = ReturnType<typeof ruleRows>[number]
const readById = (t: ReturnType<typeof idPagedTable>) =>
  readAllById(() => t.query() as unknown as IdPageableQuery<RuleRow>)

// category_rules has no `date`, so it pages on id alone (#28). Same contract as readAllRows: every
// row or an error, never part of the rows.
describe('readAllById', () => {
  it('reads past the cap, ordering by id and continuing after the last id', async () => {
    const t = idPagedTable(ruleRows(1001))
    const { data, error } = await readById(t)
    expect(error).toBeNull()
    expect(data).toHaveLength(1001)
    expect(t.requests.map((r) => r.after)).toEqual([null, 'r00999', 'r01000'])
    expect(t.requests.every((r) => r.ordered && r.limit === 1000)).toBe(true)
  })

  it('does not depend on the server cap matching the page size', async () => {
    const t = idPagedTable(ruleRows(1238), { serverCap: 500 })
    const { data } = await readById(t)
    expect(data).toHaveLength(1238)
  })

  it('fails the whole read if any page fails, keeping the code', async () => {
    const t = idPagedTable(ruleRows(1500), { failOnRequest: 2 })
    const { data, error } = await readById(t)
    expect(data).toBeNull()
    expect(error).toEqual({ message: 'boom', code: 'XX000' })
  })

  it('treats a page with neither data nor error as a failure, not the end', async () => {
    const t = idPagedTable(ruleRows(1500), { emptyBodyOnRequest: 2 })
    const { data, error } = await readById(t)
    expect(data).toBeNull()
    expect(error?.message).toMatch(/no data and no error/)
  })

  it('fails rather than loops when a page does not advance', async () => {
    const stuck = () => {
      const chain: Record<string, unknown> = {}
      for (const m of ['order', 'gt', 'limit']) chain[m] = () => chain
      chain.then = (resolve: (r: unknown) => unknown) =>
        Promise.resolve({ data: [{ id: 'r1' }], error: null }).then(resolve)
      return chain as unknown as IdPageableQuery<{ id: string }>
    }
    const { data, error } = await readAllById(stuck)
    expect(data).toBeNull()
    expect(error?.message).toMatch(/did not advance/)
  })
})
```

- [ ] **Step 3: Run them.** `npx vitest run tests/unit/read-all.test.ts`. Expected: FAIL, `readAllById` is not exported.

- [ ] **Step 4: Implement.** In `lib/read-all.ts`, widen the failure type so a code survives (`readAllRows` is unaffected):

```ts
type Failure = { data: null; error: { message: string; code?: string } }
```

and append:

```ts
// The part of a Supabase query an id-keyed read needs.
export interface IdPageableQuery<T> {
  order(column: string, options?: { ascending?: boolean }): IdPageableQuery<T>
  gt(column: string, value: string): IdPageableQuery<T>
  limit(count: number): PromiseLike<{ data: T[] | null; error: { message: string; code?: string } | null }>
}

// readAllRows for a table with no `date` column (category_rules, #28): pages on `id` alone. The
// same contract, for the same reasons: `build` returns a new, unbounded query each call; paging is
// by key; the read ends only on an empty page; a failed page, an empty body, or a page that does
// not move past the last id fails the whole read.
//
// Ids are uuids. Postgres orders uuid by its bytes, which is the order of their lowercase hex text,
// so the string comparison below agrees with the server's `order by id`.
export async function readAllById<T extends { id: string }>(
  build: () => IdPageableQuery<T>
): Promise<Success<T> | Failure> {
  const all: T[] = []
  let lastId: string | null = null
  for (;;) {
    let query = build().order('id')
    if (lastId !== null) query = query.gt('id', lastId)
    const { data, error } = await query.limit(PAGE_SIZE)
    if (error) return { data: null, error }
    if (!data) return { data: null, error: { message: 'read returned no data and no error' } }
    if (data.length === 0) return { data: all, error: null }
    const end = data[data.length - 1].id
    if (lastId !== null && end <= lastId) {
      return { data: null, error: { message: 'paged read did not advance past the last row' } }
    }
    all.push(...data)
    lastId = end
  }
}
```

- [ ] **Step 5: Run them.** Same command. Expected: PASS, and the existing `readAllRows` tests still pass.

- [ ] **Step 6: Commit.**

```bash
git add lib/read-all.ts tests/stubs/postgrest-pages.ts tests/unit/read-all.test.ts
git commit -m "Add readAllById, for tables paged by id alone (#28)"
```

---

### Task 3: `lib/category-rules.ts` (spec §5)

**Files:**
- Create: `lib/category-rules.ts`
- Create: `tests/unit/helpers/category-context.ts`
- Test: `tests/unit/category-rules.test.ts`

**Interfaces:**
- Consumes: `isCardPaymentRow`, `pfcToName`, `transferNames`, `nonSpendingNames`, `TRANSFER_PFC`, `type Category` from `lib/categories.ts`.
- Produces (every later task uses these exact names):
  - `type CategorizableTxn = { user_category: string | null; pfc_primary: string | null; pfc_detailed: string | null; merchant_name: string | null }`
  - `type CategoryRule = { id: string; household_id: string; merchant_key: string; merchant_label: string; category_id: string; origin: 'seeded' | 'learned' }`
  - `type Kind = 'spending' | 'transfer' | 'income'`
  - `type CategoryData` (branded; readable `categories: Category[]`, `rules: CategoryRule[]`)
  - `type KindContext`, `type CategoryContext` (branded; `CategoryContext` is assignable to `KindContext`)
  - `type ResolvedCategory = { name: string; source: 'pick' | 'rule' | 'bank'; ruleId: string | null; bankName: string }`
  - `merchantKey(s: string | null): string | null`
  - `buildKindContext(categories: Category[]): KindContext`
  - `buildCategoryContext(data: CategoryData, opts?: { withoutCategoryId?: string }): CategoryContext`
  - `kindOf(name: string, k: KindContext): Kind`
  - `bankCategory(t: { pfc_primary: string | null }, k: KindContext): { name: string; kind: Kind }`
  - `resolveCategory(t: CategorizableTxn, ctx: CategoryContext): ResolvedCategory`
  - `changedByRule(r: ResolvedCategory): boolean`
- Produces (tests): `tests/unit/helpers/category-context.ts` exports `HH`, `DEFAULTS`, `GROCERY`, `cat`, `rule`, `testData`, `testCtx`, `categoriesFromMap`.

- [ ] **Step 1: Write the test helper.** Create `tests/unit/helpers/category-context.ts`:

```ts
// Test-only builders for category contexts (#28). The one place outside lib/ that casts a brand:
// production code gets CategoryData only from fetchCategoryContext (lib/category-context.ts), and
// tripwire 4's brand-cast check does not scan tests.
import { DEFAULT_CATEGORIES, type Category } from '@/lib/categories'
import {
  buildCategoryContext,
  merchantKey,
  type CategoryData,
  type CategoryRule,
} from '@/lib/category-rules'

export const HH = 'hh-1'

export function cat(name: string, pfc_primary: string | null = null, sort_order = 0): Category {
  return { id: `c-${name}`, name, pfc_primary, sort_order }
}

// The household's defaults (lib/categories.ts DEFAULT_CATEGORIES) plus its own Grocery.
export const GROCERY = cat('Grocery', null, 100)
export const DEFAULTS: Category[] = [
  ...DEFAULT_CATEGORIES.map((c, i) => cat(c.name, c.pfc_primary, i)),
  GROCERY,
]

export function rule(merchant: string, categoryId: string, over: Partial<CategoryRule> = {}): CategoryRule {
  const key = merchantKey(merchant)
  if (!key) throw new Error(`rule(): '${merchant}' has no merchant key`)
  return {
    id: `r-${key}`,
    household_id: HH,
    merchant_key: key,
    merchant_label: merchant.trim(),
    category_id: categoryId,
    origin: 'learned',
    ...over,
  }
}

export function testData(categories: Category[], rules: CategoryRule[] = []): CategoryData {
  return { categories, rules } as CategoryData
}

export function testCtx(categories: Category[] = DEFAULTS, rules: CategoryRule[] = []) {
  return buildCategoryContext(testData(categories, rules))
}

// For tests written against the old `pfcMap` shape: one category per entry, in order.
export function categoriesFromMap(map: Record<string, string>): Category[] {
  return Object.entries(map).map(([pfc, name], i) => cat(name, pfc, i))
}
```

- [ ] **Step 2: Write the failing tests.** Create `tests/unit/category-rules.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  merchantKey,
  kindOf,
  bankCategory,
  buildKindContext,
  buildCategoryContext,
  resolveCategory,
  changedByRule,
  type CategorizableTxn,
  type CategoryContext,
  type CategoryData,
} from '@/lib/category-rules'
import { DEFAULTS, GROCERY, HH, cat, rule, testCtx, testData } from './helpers/category-context'

// #28 spec §5.3: resolveCategory is the only code that turns a row into a category name. Pick, then
// rule, then bank; card payments never take a rule; a rule never crosses spending/transfer/income.
const row = (over: Partial<CategorizableTxn> = {}): CategorizableTxn => ({
  user_category: null,
  pfc_primary: 'FOOD_AND_DRINK',
  pfc_detailed: null,
  merchant_name: 'Safeway',
  ...over,
})
const without = (name: string) => DEFAULTS.filter((c) => c.name !== name)
const safewayToGrocery = rule('Safeway', GROCERY.id)

describe('merchantKey', () => {
  it('is null for null, empty and whitespace', () => {
    expect(merchantKey(null)).toBeNull()
    expect(merchantKey('')).toBeNull()
    expect(merchantKey('   ')).toBeNull()
  })
  it('trims and lowercases, and nothing more', () => {
    expect(merchantKey(' SAFEWAY ')).toBe('safeway')
    expect(merchantKey('Walmart+')).toBe('walmart+')
  })
})

describe('kindOf and bankCategory', () => {
  const k = buildKindContext(DEFAULTS)
  it('names transfers first, then income, and everything else spending', () => {
    expect(kindOf('Transfer In', k)).toBe('transfer')
    expect(kindOf('Income', k)).toBe('income')
    expect(kindOf('Grocery', k)).toBe('spending')
    expect(kindOf('Uncategorized', k)).toBe('spending')
    expect(kindOf('No such category', k)).toBe('spending')
  })
  it('maps a primary to its category and kind', () => {
    expect(bankCategory({ pfc_primary: 'FOOD_AND_DRINK' }, k)).toEqual({ name: 'Food & Drink', kind: 'spending' })
    expect(bankCategory({ pfc_primary: 'TRANSFER_OUT' }, k)).toEqual({ name: 'Transfer Out', kind: 'transfer' })
  })
  it("takes an unmapped row's kind from Plaid's tag", () => {
    const noTransferOut = buildKindContext(without('Transfer Out'))
    expect(bankCategory({ pfc_primary: 'TRANSFER_OUT' }, noTransferOut)).toEqual({ name: 'Uncategorized', kind: 'transfer' })
    expect(bankCategory({ pfc_primary: 'INCOME' }, buildKindContext(without('Income')))).toEqual({ name: 'Uncategorized', kind: 'income' })
    expect(bankCategory({ pfc_primary: 'LOAN_DISBURSEMENTS' }, k)).toEqual({ name: 'Uncategorized', kind: 'spending' })
    expect(bankCategory({ pfc_primary: null }, k)).toEqual({ name: 'Uncategorized', kind: 'spending' })
  })
  it('is last-wins when two categories share a primary, like pfcToName', () => {
    const k2 = buildKindContext([...DEFAULTS, cat('Groceries & Dining', 'FOOD_AND_DRINK', 200)])
    expect(bankCategory({ pfc_primary: 'FOOD_AND_DRINK' }, k2).name).toBe('Groceries & Dining')
  })
})

describe('resolveCategory', () => {
  const ctx = testCtx(DEFAULTS, [safewayToGrocery])

  it('applies a rule when there is no pick', () => {
    expect(resolveCategory(row(), ctx)).toEqual({ name: 'Grocery', source: 'rule', ruleId: safewayToGrocery.id, bankName: 'Food & Drink' })
  })
  it('lets a hand pick beat a rule', () => {
    expect(resolveCategory(row({ user_category: 'Travel' }), ctx)).toEqual({ name: 'Travel', source: 'pick', ruleId: null, bankName: 'Food & Drink' })
  })
  it('never applies a rule to a card payment, but keeps its pick', () => {
    const card = row({ pfc_primary: 'LOAN_PAYMENTS', pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' })
    expect(resolveCategory(card, ctx)).toEqual({ name: 'Loan Payments', source: 'bank', ruleId: null, bankName: 'Loan Payments' })
    expect(resolveCategory({ ...card, user_category: 'Shopping' }, ctx).source).toBe('pick')
  })
  it.each([null, '', '  '])('never matches merchant %j', (merchant_name) => {
    expect(resolveCategory(row({ merchant_name }), ctx).source).toBe('bank')
  })
  it('matches across case and surrounding space, and nothing looser', () => {
    expect(resolveCategory(row({ merchant_name: ' SAFEWAY ' }), ctx).name).toBe('Grocery')
    const walmart = testCtx(DEFAULTS, [rule('Walmart', GROCERY.id)])
    expect(resolveCategory(row({ merchant_name: 'Walmart+' }), walmart).source).toBe('bank')
  })
  it('does not apply a spending rule to a transfer row', () => {
    expect(resolveCategory(row({ pfc_primary: 'TRANSFER_OUT' }), ctx)).toMatchObject({ name: 'Transfer Out', source: 'bank' })
  })
  it('applies a spending rule to an Uncategorized row with a spending primary', () => {
    expect(resolveCategory(row({ pfc_primary: 'LOAN_DISBURSEMENTS' }), ctx)).toMatchObject({ name: 'Grocery', source: 'rule', bankName: 'Uncategorized' })
  })
  it('after "Transfer Out" is deleted, applies neither a spending nor a transfer rule to a TRANSFER_OUT row', () => {
    const cats = without('Transfer Out')
    const spending = testCtx(cats, [safewayToGrocery])
    const transfer = testCtx(cats, [rule('Safeway', 'c-Transfer In')])
    const t = row({ pfc_primary: 'TRANSFER_OUT' })
    expect(resolveCategory(t, spending)).toMatchObject({ name: 'Uncategorized', source: 'bank' })
    expect(resolveCategory(t, transfer)).toMatchObject({ name: 'Uncategorized', source: 'bank' })
  })
  it('after "Income" is deleted, does not apply a spending rule to an INCOME row', () => {
    const t = row({ pfc_primary: 'INCOME' })
    expect(resolveCategory(t, testCtx(without('Income'), [safewayToGrocery]))).toMatchObject({ name: 'Uncategorized', source: 'bank' })
  })
  it("gives the bank category when the rule's category is missing from the context", () => {
    const dangling = testCtx(DEFAULTS, [rule('Safeway', 'c-gone')])
    expect(resolveCategory(row(), dangling)).toMatchObject({ name: 'Food & Drink', source: 'bank' })
  })
  // Review Focus 1: rules point at an id, so a rename moves every row at once.
  it('follows a renamed category', () => {
    const renamed = DEFAULTS.map((c) => (c.id === GROCERY.id ? { ...c, name: 'Groceries' } : c))
    expect(resolveCategory(row(), testCtx(renamed, [safewayToGrocery])).name).toBe('Groceries')
  })
  it('reports the bank name, and changedByRule only when the rule changed it', () => {
    const r = resolveCategory(row(), ctx)
    expect(r.bankName).toBe('Food & Drink')
    expect(changedByRule(r)).toBe(true)
    const same = resolveCategory(row(), testCtx(DEFAULTS, [rule('Safeway', 'c-Food & Drink')]))
    expect(same.source).toBe('rule')
    expect(changedByRule(same)).toBe(false)
    expect(changedByRule(resolveCategory(row({ user_category: 'Travel' }), ctx))).toBe(false)
  })
})

describe('buildCategoryContext', () => {
  it('can build as if a category and its rules were gone', () => {
    const data = testData(DEFAULTS, [safewayToGrocery])
    const gone = buildCategoryContext(data, { withoutCategoryId: GROCERY.id })
    expect(resolveCategory(row(), gone)).toMatchObject({ name: 'Food & Drink', source: 'bank' })
    const foodGone = buildCategoryContext(data, { withoutCategoryId: 'c-Food & Drink' })
    expect(resolveCategory(row({ merchant_name: 'Other' }), foodGone).name).toBe('Uncategorized')
  })
  it('throws on rules from more than one household', () => {
    const data = testData(DEFAULTS, [safewayToGrocery, rule('Giant', GROCERY.id, { household_id: 'hh-2' })])
    expect(() => buildCategoryContext(data)).toThrow('category rules span more than one household')
  })
  it('accepts a CategoryContext wherever a KindContext is', () => {
    const ctx: CategoryContext = testCtx()
    expect(kindOf('Income', ctx)).toBe('income')
  })
  it('refuses hand-built contexts and data at compile time', () => {
    // @ts-expect-error a literal is not a CategoryContext
    const literal: CategoryContext = {}
    // @ts-expect-error data must come from fetchCategoryContext
    const data: CategoryData = { categories: DEFAULTS, rules: [] }
    expect([literal, data, HH]).toBeTruthy()
  })
})
```

- [ ] **Step 3: Run them.** `npx vitest run tests/unit/category-rules.test.ts`. Expected: FAIL, the module does not exist.

- [ ] **Step 4: Implement.** Create `lib/category-rules.ts`:

```ts
// Category rules (#28): turning a transaction into a category NAME. Pure, no I/O.
//
// resolveCategory is the ONLY code that does this. Every page, count and filter goes through it,
// so precedence (a hand pick, then the merchant's rule, then the bank's category), the card-payment
// exemption and the kind gate live in one place. A rule's effect exists only here, at read time:
// nothing is written to transactions, so changing or removing a rule moves every row with it.
import {
  isCardPaymentRow,
  nonSpendingNames,
  pfcToName,
  transferNames,
  TRANSFER_PFC,
  type Category,
} from './categories'

// All four REQUIRED, so a page whose select drops one fails tsc instead of resolving wrongly.
export type CategorizableTxn = {
  user_category: string | null
  pfc_primary: string | null
  pfc_detailed: string | null
  merchant_name: string | null
}

export type CategoryRule = {
  id: string
  household_id: string
  merchant_key: string
  merchant_label: string
  category_id: string
  origin: 'seeded' | 'learned'
}

export type Kind = 'spending' | 'transfer' | 'income'

export type ResolvedCategory = {
  name: string
  source: 'pick' | 'rule' | 'bank'
  ruleId: string | null
  bankName: string // what the bank mapping alone would show
}

// Brands. A page that forgets the rules must not compile: CategoryData comes only from
// fetchCategoryContext (lib/category-context.ts), and the two contexts only from the builders
// below. A hand-built `{ categories, rules: [] }` lacks the brand and fails tsc. The state lives
// under non-exported symbol keys (not a WeakMap or #private) so buildSpendContext can spread a
// context. Tripwire 4 (scripts/check-invariants.mjs) rejects `as CategoryData` and friends outside
// this file, lib/category-context.ts and lib/spend-context.ts.
declare const DATA_BRAND: unique symbol
const KIND_STATE = Symbol('kind-context')
const RULE_STATE = Symbol('category-context')

export type CategoryData = {
  readonly categories: Category[]
  readonly rules: CategoryRule[]
  readonly [DATA_BRAND]: true
}

type KindState = {
  pfcMap: Record<string, string> // Plaid primary -> category name (last wins, as pfcToName)
  transfers: Set<string> // the exact sets the totals branch on
  nonSpending: Set<string>
}
type RuleState = {
  byKey: Map<string, CategoryRule>
  nameById: Map<string, string>
}

export type KindContext = { readonly [KIND_STATE]: KindState }
export type CategoryContext = KindContext & { readonly [RULE_STATE]: RuleState }

// null for null, '' or whitespace; otherwise trimmed and lowercased. Matches the seed's
// lower(trim()) on ASCII, which the launch checks prove every live merchant name is.
export function merchantKey(s: string | null): string | null {
  const k = (s ?? '').trim().toLowerCase()
  return k || null
}

export function buildKindContext(categories: Category[]): KindContext {
  return {
    [KIND_STATE]: {
      pfcMap: pfcToName(categories),
      transfers: transferNames(categories),
      nonSpending: nonSpendingNames(categories),
    },
  }
}

// `withoutCategoryId` builds the context as if that category, and every rule pointing at it, were
// already deleted: deleteImpact (lib/category-views.ts) uses it to say what a delete would move.
export function buildCategoryContext(
  data: CategoryData,
  opts: { withoutCategoryId?: string } = {}
): CategoryContext {
  // The read side assumes one household per user (lib/spend-context.ts). Make that fail loudly for
  // rules rather than silently applying another household's.
  if (new Set(data.rules.map((r) => r.household_id)).size > 1) {
    throw new Error('category rules span more than one household')
  }
  const gone = opts.withoutCategoryId
  const categories = gone ? data.categories.filter((c) => c.id !== gone) : data.categories
  const rules = gone ? data.rules.filter((r) => r.category_id !== gone) : data.rules
  const byKey = new Map<string, CategoryRule>()
  for (const r of rules) byKey.set(r.merchant_key, r)
  return {
    ...buildKindContext(categories),
    [RULE_STATE]: { byKey, nameById: new Map(categories.map((c) => [c.id, c.name])) },
  }
}

// How the totals count a category name. Transfers first, because the non-spending set contains
// them. 'Uncategorized', and any name no category holds, is in neither, so it counts as spending.
export function kindOf(name: string, k: KindContext): Kind {
  const s = k[KIND_STATE]
  if (s.transfers.has(name)) return 'transfer'
  if (s.nonSpending.has(name)) return 'income'
  return 'spending'
}

function plaidKind(pfcPrimary: string | null): Kind {
  if (pfcPrimary && TRANSFER_PFC.has(pfcPrimary)) return 'transfer'
  if (pfcPrimary === 'INCOME') return 'income'
  return 'spending'
}

// The category the bank's tag maps to, and its kind. When the primary maps to no household
// category (its default was deleted, or Plaid sent one with no default), the row SHOWS as
// 'Uncategorized' but its kind comes from Plaid's own tag, so the two can differ; see resolveCategory.
export function bankCategory(t: { pfc_primary: string | null }, k: KindContext): { name: string; kind: Kind } {
  const mapped = t.pfc_primary ? k[KIND_STATE].pfcMap[t.pfc_primary] : undefined
  if (mapped) return { name: mapped, kind: kindOf(mapped, k) }
  return { name: 'Uncategorized', kind: plaidKind(t.pfc_primary) }
}

export function resolveCategory(t: CategorizableTxn, ctx: CategoryContext): ResolvedCategory {
  const bank = bankCategory(t, ctx)
  const asBank: ResolvedCategory = { name: bank.name, source: 'bank', ruleId: null, bankName: bank.name }
  // 1. A hand pick wins, even on a card payment (the existing "user override wins" contract).
  if (t.user_category) return { name: t.user_category, source: 'pick', ruleId: null, bankName: bank.name }
  // 2. Card payments never take a rule: any category on one re-enters it into every total (#59).
  //    pfc_detailed alone, never isCreditCardPayment.
  if (isCardPaymentRow(t.pfc_detailed)) return asBank
  // 3. The merchant's rule, only within one kind. The rule's kind must equal BOTH Plaid's kind for
  //    the row and the kind of the name the totals would otherwise count it under. For a mapped
  //    row those agree; for an unmapped one they can differ, and the row then takes no rule and
  //    stays counted exactly as it is today. So no set of rules moves Spent, Income or Saved.
  const key = merchantKey(t.merchant_name)
  const rule = key ? ctx[RULE_STATE].byKey.get(key) : undefined
  const name = rule ? ctx[RULE_STATE].nameById.get(rule.category_id) : undefined
  if (rule && name) {
    const kind = kindOf(name, ctx)
    if (kind === bank.kind && kind === kindOf(bank.name, ctx)) {
      return { name, source: 'rule', ruleId: rule.id, bankName: bank.name }
    }
  }
  return asBank
}

// A rule that relabelled the row, as opposed to one that agrees with the bank. Drives the learned
// marker and the Settings counts.
export function changedByRule(r: ResolvedCategory): boolean {
  return r.source === 'rule' && r.name !== r.bankName
}
```

- [ ] **Step 5: Run them.** `npx vitest run tests/unit/category-rules.test.ts && npx tsc --noEmit`. Expected: PASS, and tsc reports nothing new. The two `@ts-expect-error` lines must be needed: if tsc reports "Unused '@ts-expect-error' directive", the brand is not working; fix the brand, not the test.

- [ ] **Step 6: Commit.**

```bash
git add lib/category-rules.ts tests/unit/helpers/category-context.ts tests/unit/category-rules.test.ts
git commit -m "Resolve a transaction's category through one function, with merchant rules (#28)"
```

---

### Task 4: `lib/category-context.ts` (spec §7.1)

**Files:**
- Create: `lib/category-context.ts`
- Test: `tests/unit/category-context.test.ts`

**Interfaces:**
- Consumes: `readAllRows`, `readAllById` (Task 2); `CategoryData`, `CategoryRule`, `CategorizableTxn` (Task 3).
- Produces:
  - `fetchCategoryContext: () => Promise<CategoryData>` (React `cache`d per render; throws).
  - `type CountTxn = CategorizableTxn & { id: string; date: string }`
  - `readTransactionsForCounts(): Promise<CountTxn[]>` (every non-removed row; throws).
  Tasks 5–9 import both from `@/lib/category-context`.

- [ ] **Step 1: Write the failing tests.** Create `tests/unit/category-context.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'

// #28 spec §7.1: the one server read of categories and rules. A failed rules read must never
// render as "no rules": that would silently revert every learned label (#46).
const { tables } = vi.hoisted(() => ({
  tables: {} as Record<string, () => Record<string, unknown>>,
}))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ from: (table: string) => tables[table]() }),
}))

import { fetchCategoryContext, readTransactionsForCounts } from '@/lib/category-context'
import { readAllRows } from '@/lib/read-all'
import { idPagedTable, pagedTable, ruleRows, txnRows } from '../stubs/postgrest-pages'
import type { CategorizableTxn } from '@/lib/category-rules'

const categoriesRead = (result: { data: unknown; error: { message: string } | null }) => () => {
  const chain: Record<string, unknown> = {}
  chain.select = () => chain
  chain.order = (col: string) => {
    if (col !== 'sort_order') throw new Error(`unexpected order ${col}`)
    return chain
  }
  chain.then = (resolve: (r: unknown) => unknown) => Promise.resolve(result).then(resolve)
  return chain
}
const CATS = [{ id: 'c1', name: 'Grocery', pfc_primary: null, sort_order: 0 }]

beforeEach(() => {
  tables.categories = categoriesRead({ data: CATS, error: null })
  tables.category_rules = idPagedTable([]).query
  tables.transactions = pagedTable([]).query
})

describe('fetchCategoryContext', () => {
  it('returns the categories in order and every rule', async () => {
    const rules = idPagedTable(ruleRows(1001))
    tables.category_rules = rules.query
    const data = await fetchCategoryContext()
    expect(data.categories).toEqual(CATS)
    expect(data.rules).toHaveLength(1001)
    expect(rules.requests.map((r) => r.after)).toEqual([null, 'r00999', 'r01000'])
  })

  it('throws when the categories read fails', async () => {
    tables.categories = categoriesRead({ data: null, error: { message: 'permission denied' } })
    await expect(fetchCategoryContext()).rejects.toThrow('could not read categories: permission denied')
  })

  it('throws, naming the migration, when the rules read fails on any page', async () => {
    tables.category_rules = idPagedTable(ruleRows(1500), { failOnRequest: 2 }).query
    await expect(fetchCategoryContext()).rejects.toThrow(
      'could not read category rules: XX000 boom (has db/migrations/021, including its grants, been applied?)'
    )
  })
})

describe('readTransactionsForCounts', () => {
  it('reads 1,238 rows in pages of 1,000 and 238, then an empty page', async () => {
    const t = pagedTable(txnRows(1238, '2025-10-01', { merchant_name: null, user_category: null, pfc_primary: null, pfc_detailed: null }))
    tables.transactions = t.query
    expect(await readTransactionsForCounts()).toHaveLength(1238)
    expect(t.requests).toHaveLength(3)
  })

  it('returns every row when the server caps pages at 500', async () => {
    tables.transactions = pagedTable(txnRows(1238), { serverCap: 500 }).query
    expect(await readTransactionsForCounts()).toHaveLength(1238)
  })

  it('throws when the second page fails', async () => {
    tables.transactions = pagedTable(txnRows(1238), { failOnRequest: 2 }).query
    await expect(readTransactionsForCounts()).rejects.toThrow('could not read transactions: boom')
  })
})

// Spec §7.4 layer 2: a read that drops a column the resolver needs must fail tsc. This function is
// never called; `npx tsc --noEmit` is the test.
async function _missingMerchantName(): Promise<(CategorizableTxn & { id: string; date: string })[]> {
  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()
  const { data } = await readAllRows(() =>
    supabase.from('transactions').select('id, date, user_category, pfc_primary, pfc_detailed').eq('removed', false)
  )
  // @ts-expect-error merchant_name is not selected
  return data ?? []
}
void _missingMerchantName
```

- [ ] **Step 2: Run them.** `npx vitest run tests/unit/category-context.test.ts`. Expected: FAIL, the module does not exist.

- [ ] **Step 3: Implement.** Create `lib/category-context.ts`:

```ts
import 'server-only'
import { cache } from 'react'
import { createClient } from './supabase/server'
import { readAllById, readAllRows } from './read-all'
import type { CategorizableTxn, CategoryData, CategoryRule } from './category-rules'
import type { Category } from './categories'

// The ONE read of the household's categories and category rules (#28 spec §7.1). Every money page
// and Settings goes through it; tripwire 4 holds every other `.from('categories')` and
// `.from('category_rules')` to a named allowlist.
//
// Cached per render (the lib/household.ts pattern), so a page that asks twice reads once.
//
// It THROWS on either read. A failed rules read rendered as "no rules" would silently revert every
// learned label across the app, which is #46's failure in a new place. Money pages let it reach
// app/(app)/error.tsx; Settings catches it so Banks stays usable.
export const fetchCategoryContext = cache(async (): Promise<CategoryData> => {
  const supabase = await createClient()
  const [cats, rules] = await Promise.all([
    supabase.from('categories').select('id, name, pfc_primary, sort_order').order('sort_order'),
    readAllById(() =>
      supabase
        .from('category_rules')
        .select('id, household_id, merchant_key, merchant_label, category_id, origin')
    ),
  ])
  if (cats.error) throw new Error(`could not read categories: ${cats.error.message}`)
  if (rules.error) {
    throw new Error(
      `could not read category rules: ${rules.error.code ?? ''} ${rules.error.message} ` +
        '(has db/migrations/021, including its grants, been applied?)'
    )
  }
  // The one place outside lib/category-rules.ts that brands CategoryData.
  return { categories: (cats.data ?? []) as Category[], rules: rules.data as CategoryRule[] } as CategoryData
})

export type CountTxn = CategorizableTxn & { id: string; date: string }

// Every non-removed transaction, with exactly the columns resolveCategory needs, for Settings'
// counts and the delete-category dialog. Paged (#69): about 1,400 rows today, three requests.
export async function readTransactionsForCounts(): Promise<CountTxn[]> {
  const supabase = await createClient()
  const { data, error } = await readAllRows(() =>
    supabase
      .from('transactions')
      .select('id, date, merchant_name, user_category, pfc_primary, pfc_detailed')
      .eq('removed', false)
  )
  if (error) throw new Error(`could not read transactions: ${error.message}`)
  return data
}
```

If `rules.error.code` is undefined the message reads `could not read category rules:  boom …` with two spaces; the test fixture carries a code, and the double space is harmless in a log. If tsc rejects `readAllById(() => supabase.from('category_rules')…)` because postgrest's `gt` overloads don't match `IdPageableQuery`, widen `IdPageableQuery.gt`'s value parameter to `unknown` in `lib/read-all.ts`; do not cast at the call site.

- [ ] **Step 4: Run them.** `npx vitest run tests/unit/category-context.test.ts && npx tsc --noEmit`. Expected: PASS, and tsc clean. If tsc reports the `@ts-expect-error` as unused, the select's row type is not being inferred and §7.4 layer 2 doesn't hold: stop and report it rather than deleting the probe.

- [ ] **Step 5: Commit.**

```bash
git add lib/category-context.ts tests/unit/category-context.test.ts
git commit -m "Read categories and rules through one helper that throws (#28)"
```

---

### Task 5: The money layer on the context, and the six pages onto it

**Files:**
- Modify: `lib/spend-context.ts`, `lib/effective-category.ts`, `lib/budget.ts` (the `Txn` type and `spendByCategory`), `lib/dashboard.ts` (`FlowTxn` and `monthlyFlows`)
- Modify: `app/(app)/dashboard/page.tsx`, `budgets/page.tsx`, `trends/page.tsx`, `breakdown/[metric]/page.tsx`, `transactions/page.tsx`, `settings/page.tsx`
- Modify tests: `effective-category.test.ts`, `spend-context.test.ts`, `budget.test.ts`, `dashboard.test.ts`, `trends-view.test.ts`, `reimbursement-reconciliation.test.ts`, and the six page tests
- Create test: `tests/unit/category-money.test.ts`

**Interfaces:**
- Consumes: Task 3's builders and resolver; Task 4's `fetchCategoryContext`.
- Produces:
  - `type SpendContext = CategoryContext & { reimbursedByTxn: Record<string, number> }`
  - `buildSpendContext(input: { data: CategoryData; txns: ReimbursableTxn[] }): SpendContext`
  - `effectiveCategory(t: CategorizableTxn, ctx: CategoryContext): string`
  - `Txn` and `FlowTxn` gain `merchant_name: string | null`.
  - Every page reads categories through `fetchCategoryContext()`; none reads `categories` itself.

This task changes `buildSpendContext`'s signature, so every caller changes in the same commit to keep tsc green. Transactions and Settings get only the minimum here (`resolveCategory(t, ctx).name` in place of `effectiveCategory(t, pfcMap)`); Tasks 6 and 7 replace their logic.

- [ ] **Step 1: Write the money property tests (failing).** Create `tests/unit/category-money.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { monthlyFlows, type FlowTxn } from '@/lib/dashboard'
import { spendByCategory } from '@/lib/budget'
import { buildSpendContext } from '@/lib/spend-context'
import type { Category } from '@/lib/categories'
import type { CategoryRule } from '@/lib/category-rules'
import { DEFAULTS, GROCERY, cat, rule, testData } from './helpers/category-context'

// #28 spec §5.4: rules change only which category a dollar sits in. No set of rules may change
// Spent, Income or Saved, for any set of categories, including ones with a default Income or
// Transfer category deleted and one named "Uncategorized".
const MONTHS = [{ key: '2026-09', label: 'Sep' }]
const r = (id: string, merchant_name: string | null, amount: number, pfc_primary: string | null, over: Partial<FlowTxn> = {}): FlowTxn & { reimbursable_amount: number | null } => ({
  id, date: '2026-09-10', amount, merchant_name, user_category: null, pfc_primary, pfc_detailed: null, reimbursable_amount: null, ...over,
})
const ROWS = [
  r('a', 'Safeway', 50, 'FOOD_AND_DRINK'),
  r('b', 'Safeway', -10, 'FOOD_AND_DRINK'), // a refund
  r('c', 'Acme Payroll', -3000, 'INCOME'),
  r('d', 'Acme Payroll', 25, 'INCOME'), // a clawback
  r('e', 'Savings', 500, 'TRANSFER_OUT'),
  r('f', 'Savings', -500, 'TRANSFER_IN'),
  r('g', 'Chase', 7866.69, 'LOAN_PAYMENTS', { pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' }),
  r('h', 'Lender', -1000, 'LOAN_DISBURSEMENTS'), // unmapped primary
  r('i', 'Safeway', 12, 'FOOD_AND_DRINK', { user_category: 'Travel' }),
  r('j', 'Venmo', 40, 'TRANSFER_OUT'),
  r('k', null, 30, 'GENERAL_MERCHANDISE'),
]
const merchants = [...new Set(ROWS.map((x) => x.merchant_name).filter((m): m is string => !!m))]
const without = (name: string) => DEFAULTS.filter((c) => c.name !== name)
const SETS: [string, Category[]][] = [
  ['the defaults', DEFAULTS],
  ['no Income', without('Income')],
  ['no Transfer In', without('Transfer In')],
  ['no Transfer Out', without('Transfer Out')],
  ['a category named Uncategorized', [...DEFAULTS, cat('Uncategorized', null, 300)]],
]

function totals(categories: Category[], rules: CategoryRule[]) {
  const ctx = buildSpendContext({ data: testData(categories, rules), txns: ROWS })
  const [m] = monthlyFlows(ROWS, ctx, MONTHS)
  const byCat = spendByCategory(ROWS, ctx)
  return { spending: m.spending, income: m.income, spent: Object.values(byCat).reduce((s, v) => s + v, 0), byCat }
}

describe('rules and money', () => {
  it("moves Safeway's spending from Food & Drink to Grocery", () => {
    const before = totals(DEFAULTS, []).byCat
    const after = totals(DEFAULTS, [rule('Safeway', GROCERY.id)]).byCat
    expect(before['Food & Drink']).toBe(40)
    expect(after['Food & Drink']).toBeUndefined()
    expect(after.Grocery).toBe(40) // 50 out, 10 refunded: the refund nets the rule's category down
  })

  it('keeps a matching card payment out of both totals', () => {
    const { spending, income } = totals(DEFAULTS, [rule('Chase', GROCERY.id)])
    expect(spending).toBe(totals(DEFAULTS, []).spending)
    expect(income).toBe(totals(DEFAULTS, []).income)
  })

  for (const [label, cats] of SETS) {
    it(`never moves Spent or Income for any single rule, over ${label}`, () => {
      const before = totals(cats, [])
      for (const m of merchants) {
        for (const c of cats) {
          const after = totals(cats, [rule(m, c.id)])
          expect(after.spending, `${m} → ${c.name}`).toBeCloseTo(before.spending, 2)
          expect(after.income, `${m} → ${c.name}`).toBeCloseTo(before.income, 2)
          expect(after.spent, `${m} → ${c.name}`).toBeCloseTo(before.spent, 2)
        }
      }
    })

    it(`never moves Spent or Income for many rules at once, over ${label}`, () => {
      let seed = 28 // deterministic, so a failure reproduces
      const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
      const before = totals(cats, [])
      for (let n = 0; n < 200; n++) {
        const rules = merchants.filter(() => rand() < 0.6).map((m) => rule(m, cats[Math.floor(rand() * cats.length)].id))
        const after = totals(cats, rules)
        expect(after.spending).toBeCloseTo(before.spending, 2)
        expect(after.income).toBeCloseTo(before.income, 2)
        expect(after.spent).toBeCloseTo(before.spent, 2)
      }
    })
  }
})
```

- [ ] **Step 2: Run it.** `npx vitest run tests/unit/category-money.test.ts`. Expected: FAIL (tsc-level: `buildSpendContext` takes `categories`, `FlowTxn` has no `merchant_name`).

- [ ] **Step 3: Rewrite the money layer.**

`lib/spend-context.ts`, entire file:

```ts
import { buildCategoryContext, type CategoryContext, type CategoryData } from './category-rules'
import { reimbursableByTxn, type ReimbursableTxn } from './reimbursements'

// Everything the spending calculations need, assembled once per page: the household's categories
// and rules (a CategoryContext, so resolveCategory and kindOf work on it) plus the reimbursable map.
// Bundled because the five money surfaces used to assemble these by hand, and a page that forgot
// one still compiled and silently miscounted.
export type SpendContext = CategoryContext & {
  reimbursedByTxn: Record<string, number> // transaction id -> reimbursable amount
}

// `data` comes only from fetchCategoryContext (lib/category-context.ts), so a page cannot build a
// context without the rules. `txns` are the surface's OWN rows: reimbursable lives on the
// transaction, so there is no second query to forget.
export function buildSpendContext(input: { data: CategoryData; txns: ReimbursableTxn[] }): SpendContext {
  return { ...buildCategoryContext(input.data), reimbursedByTxn: reimbursableByTxn(input.txns) }
}
```

`lib/effective-category.ts`, entire file:

```ts
import { resolveCategory, type CategorizableTxn, type CategoryContext } from './category-rules'

// A transaction's effective category NAME: its hand pick, else its merchant's rule (#28), else the
// household category its Plaid primary maps to, else 'Uncategorized'. See resolveCategory.
export function effectiveCategory(t: CategorizableTxn, ctx: CategoryContext): string {
  return resolveCategory(t, ctx).name
}
```

`lib/budget.ts`: add `merchant_name: string | null` to `Txn` after `date`; replace the imports of `effectiveCategory` with `import { kindOf, resolveCategory } from './category-rules'`; and replace `spendByCategory`'s loop body:

```ts
  for (const t of txns) {
    if (isCreditCardPayment(t)) continue // internal transfer, not spending
    const cat = resolveCategory(t, ctx).name
    if (kindOf(cat, ctx) !== 'spending') continue // income + transfers
    // spendableAmount, not t.amount: the reimbursable portion is not the user's spending, and a
    // tagged repayment contributes 0 rather than netting the category down like a refund.
    // Outflows add; genuine refunds (untagged inflows in a spending category) still net down.
    out[cat] = (out[cat] ?? 0) + spendableAmount(t, ctx.reimbursedByTxn)
  }
```

`lib/dashboard.ts`: add `merchant_name: string | null` to `FlowTxn` after `date`; swap the `effectiveCategory` import for `import { kindOf, resolveCategory } from './category-rules'`; in the header comment of `monthlyFlows` replace "`ctx.nonSpending` (income + transfers)" with "income and transfer categories" and "`ctx.transfers` (transfers only)" with "transfer categories"; replace the loop's category lines:

```ts
    if (isCreditCardPayment(t)) continue
    const kind = kindOf(resolveCategory(t, ctx).name, ctx)
    // Transfers are neither spending nor income.
    if (kind === 'transfer') continue
    const isIncomeCategory = kind === 'income'
```

- [ ] **Step 4: Rewire the existing unit tests.** Assertions keep their meaning; only how contexts are built changes.
  - `effective-category.test.ts`: build `const ctx = testCtx(categoriesFromMap(pfcMap))` from the file's existing map and call `effectiveCategory({ ...row, pfc_detailed: null, merchant_name: null }, ctx)`. Add one case: with `rule('Safeway', GROCERY.id)` over `DEFAULTS`, a Safeway Food & Drink row is `'Grocery'`.
  - `spend-context.test.ts`: call `buildSpendContext({ data: testData(categories), txns })`. Replace each `ctx.pfcMap[...]`, `ctx.nonSpending.has(...)` and `ctx.transfers.has(...)` assertion with the public equivalent: `bankCategory({ pfc_primary: 'FOOD_AND_DRINK' }, ctx).name === 'Food & Drink'`, `kindOf('Income', ctx) === 'income'`, `kindOf('Transfer In', ctx) === 'transfer'`, `kindOf('Food & Drink', ctx) === 'spending'`, `kindOf('Reimbursable-ish custom', ctx) === 'spending'`. Add: "resolves a rule through a built SpendContext" (`resolveCategory` of a Safeway row with `rule('Safeway', GROCERY.id)` over `DEFAULTS` is `Grocery`, and `reimbursedByTxn` is still built).
  - `budget.test.ts`: replace the `ctx` helper with

    ```ts
    const ctx = (
      over: { reimbursedByTxn?: Record<string, number> } = {},
      map: Record<string, string> = pfcMap
    ): SpendContext => ({
      ...buildSpendContext({ data: testData(categoriesFromMap({ TRANSFER_IN: 'Transfer In', ...map })), txns: [] }),
      reimbursedByTxn: over.reimbursedByTxn ?? {},
    })
    ```

    (`TRANSFER_IN` is added because the old helper's `transfers` set always held "Transfer In" whatever the map), drop the now-unused `nonSpending` const, and add `merchant_name: null` to the `t()` fixture builder.
  - `dashboard.test.ts`, `trends-view.test.ts`, `reimbursement-reconciliation.test.ts`: build contexts the same way (`buildSpendContext({ data: testData(<categories>), txns })`), and add `merchant_name: null` to every `Txn`/`FlowTxn` fixture. Keep `dashboard.test.ts`'s "honors a user override on a credit-card payment" exactly as it is.

- [ ] **Step 5: Move the six pages onto `fetchCategoryContext`.** In each, delete the `.from('categories')` read and its comment, and the `pfcToName`/`Category`/`effectiveCategory` imports that become unused. Then:

  - **Dashboard** (`app/(app)/dashboard/page.tsx`):
    - `import { fetchCategoryContext } from '@/lib/category-context'` and `import { resolveCategory } from '@/lib/category-rules'`.
    - Where the categories read was: `const data = await fetchCategoryContext()`, with the old comment's substance kept above it: `// Throws on a failed read. With no categories nothing maps to Income or Transfer and a paycheck counts as negative spending (measured: "Spent" -$1,796.70 against a true $3,929.35), so a failure must not become a plausible number (#46).`
    - Flows select becomes `'id, amount, date, merchant_name, user_category, pfc_primary, pfc_detailed, reimbursable_amount'`.
    - `const allRows = flowTxns ?? []` and `const ctx = buildSpendContext({ data, txns: allRows })`; `monthlyFlows(allRows, ctx, months)`. The `as Txn[]` and `as FlowTxn[]` casts go; drop the then-unused `Txn`/`FlowTxn` imports.
    - Recent activity: `category: resolveCategory(t, ctx).name` (Task 6 replaces this with `activityItem`).
  - **Budgets:** `const data = await fetchCategoryContext()`; `const categoryNames = spendingCategoryNames(data.categories)`; select adds `merchant_name`; `const rows = txns ?? []`; `const ctx = buildSpendContext({ data, txns: rows })`; `spendByCategory(rows, ctx)`. Casts go.
  - **Trends:** same pattern; `const list = txns ?? []`; casts go; `trendsView(windows, list, ctx)`.
  - **Breakdown** (spent/saved branch only): same pattern; select adds `merchant_name`; `const allRows = flowTxns ?? []`; casts on `allRows` and `monthlyFlows` go. Net-worth and cash branches unchanged.
  - **Transactions:** `const data = await fetchCategoryContext()`; `const categoryOptions = data.categories.map((c) => c.name)`; `const ctx = buildSpendContext({ data, txns: (txns ?? []) as RealRow[] })`; replace the three `effectiveCategory(t, pfcMap)` with `resolveCategory(t, ctx).name`; in the flow filter replace `ctx.transfers.has(cat)` / `ctx.nonSpending.has(cat) && !ctx.transfers.has(cat)` with `const kind = kindOf(cat, ctx)`, `if (kind === 'transfer') return false`, `const isIncomeCat = kind === 'income'`. (Task 6 replaces all of this with `lib/category-views.ts`.)
  - **Settings:** `const data = await fetchCategoryContext()`; `const categories = data.categories`; `const ctx = buildCategoryContext(data)`; the transactions select becomes `'id, date, merchant_name, user_category, pfc_primary, pfc_detailed'`; `const name = resolveCategory(t, ctx).name`. Keep the rest. (Task 7 rewrites this page.)

- [ ] **Step 6: Mock `@/lib/category-context` in the six page tests.** Each page test already drives categories through `results.categories`. Keep that, and add a mock that builds `CategoryData` from it, so every existing case keeps its meaning and the "could not read categories" cases still reject with that message. Add to each of `dashboard-page`, `trends-page`, `breakdown-page`, `transactions-page`, `settings-page` (after the `vi.mock('@/lib/supabase/server', …)` block):

```ts
// Categories and rules come through lib/category-context.ts (#28), whose own test covers paging.
// Built from `results.categories` / `results.category_rules`, so a failed categories read still
// rejects with the page's message.
vi.mock('@/lib/category-context', async () => {
  const { testData } = await import('./helpers/category-context')
  return {
    fetchCategoryContext: async () => {
      const c = results.categories ?? { data: [], error: null }
      if (c.error) throw new Error(`could not read categories: ${c.error.message}`)
      const r = results.category_rules ?? { data: [], error: null }
      if (r.error) throw new Error(`could not read category rules: ${r.error.message}`)
      return testData(c.data as never, r.data as never)
    },
    readTransactionsForCounts: async () => {
      const t = results.transactions ?? { data: [], error: null }
      if (t.error) throw new Error(`could not read transactions: ${t.error.message}`)
      return t.data
    },
  }
})
```

(`settings-page.test.tsx`'s `results` type needs `category_rules`; widen the record type if tsc asks.) `budgets-page.test.tsx` has no `results` map and one stub for every table: make it per-table, the same shape as `trends-page.test.tsx` (a hoisted `results: Record<string, { data: unknown; error: … }>` and `chainFor(table)` resolving `results[table] ?? { data: [], error: null }`, keeping the `gte`/`lt` capture), then add the mock above.

- [ ] **Step 7: Page relabel and failure tests.** Add to each test file. Each seeds one Safeway → Grocery rule and a Safeway Food & Drink row:

```ts
// Shared fixture, defined at the top of each file after its imports.
const FOOD = { id: 'c-food', name: 'Food & Drink', pfc_primary: 'FOOD_AND_DRINK', sort_order: 0 }
const GROCERY = { id: 'c-grocery', name: 'Grocery', pfc_primary: null, sort_order: 1 }
const SAFEWAY_RULE = { id: 'r-safeway', household_id: 'hh-1', merchant_key: 'safeway', merchant_label: 'Safeway', category_id: 'c-grocery', origin: 'seeded' }
```

  - `budgets-page.test.tsx`, "files Safeway under Grocery through its rule": set the system time to `2026-09-15T12:00:00Z`; `results.categories = { data: [FOOD, GROCERY], error: null }`; `results.category_rules = { data: [SAFEWAY_RULE], error: null }`; `results.transactions = { data: [{ id: 't1', amount: 42, date: '2026-09-10', merchant_name: 'Safeway', user_category: null, pfc_primary: 'FOOD_AND_DRINK', pfc_detailed: null, reimbursable_amount: null }], error: null }`; find `BudgetEditor`'s props in the returned tree (add the file's own `findProps`, copied from `settings-page.test.tsx`) and expect `props.spend` to equal `{ Grocery: 42 }`. And "throws when the categories and rules cannot be read": `results.category_rules = { data: null, error: { message: 'boom' } }` → `rejects.toThrow(/could not read category rules/)`.
  - `trends-page.test.tsx`: the same rows dated in the last complete month for the file's existing fake time; expect the tree's `SpendByCategoryChart` `data` prop to contain `{ category: 'Grocery', amount: 42 }` and no Food & Drink row. Failure case as above.
  - `breakdown-page.test.tsx`: on `spent`, the `BreakdownList` rows contain one with `label: 'Grocery'` and `amount: 42`; on `saved`, with a `results.categories` that also holds Income and an income row, Money in and Money out are identical with and without `results.category_rules` set. Failure case on `spent`.
  - `dashboard-page.test.tsx`: "throws when the rules cannot be read" (same shape). The Recent activity relabel lands in Task 6.
  - `transactions-page.test.tsx` and `settings-page.test.tsx`: no new cases here; their relabel tests are in Tasks 6 and 7. The existing Settings #69 paging test now reads through `readTransactionsForCounts`'s mock: change its fixture from `paged.transactions = pagedTable(…)` to `results.transactions = { data: txnRows(1366, '2025-10-18', { merchant_name: null, user_category: 'Groceries', pfc_primary: 'FOOD_AND_DRINK', pfc_detailed: null }), error: null }`, keeping the 1,366 assertion. Its "throws on a later page" case stays as is until Task 7 replaces it (the mock throws `could not read transactions: …` when `results.transactions.error` is set; set that instead of `failOnRequest`).

- [ ] **Step 8: Run everything.** `npx vitest run && npx tsc --noEmit && npm run check:invariants`. Expected: all PASS. Tripwire 3 must still pass: every `.from('transactions')` read stays inside `readAllRows(` or bounded.

- [ ] **Step 9: Commit.**

```bash
git add lib app tests
git commit -m "Resolve every money page's categories through the rules context (#28)"
```

---

### Task 6: Filters and recent activity in `lib/category-views.ts` (spec §7.2)

**Files:**
- Create: `lib/category-views.ts`
- Modify: `app/(app)/transactions/page.tsx`, `app/(app)/dashboard/page.tsx`
- Test: `tests/unit/category-views.test.ts`, `tests/unit/transactions-page.test.tsx`, `tests/unit/dashboard-page.test.tsx`

**Interfaces:**
- Consumes: `resolveCategory`, `kindOf`, `CategorizableTxn`, `CategoryContext` (Task 3); `SpendContext` (Task 5); `isCreditCardPayment`; `spendableAmount`, `ReimbursableTxn`; `presentTransaction`, `PresentableTxn` (`lib/transaction-presentation.ts`; confirm the type name with `grep -n "export type" lib/transaction-presentation.ts` and use whatever it exports for `presentTransaction`'s parameter).
- Produces:
  - `filterByCategory<T extends CategorizableTxn>(rows: T[], name: string, ctx: CategoryContext): T[]`
  - `filterByFlow<T extends CategorizableTxn & ReimbursableTxn>(rows: T[], flow: 'in' | 'out', ctx: SpendContext): T[]`
  - `activityItem(t, ctx: CategoryContext): { id: string; date: string; category: string; label: string; display: number; tone: …; isInternal: boolean }`
  Task 7 adds `categoryUsage` and `deleteImpact` to this file.

- [ ] **Step 1: Write the failing tests.** Create `tests/unit/category-views.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { filterByCategory, filterByFlow, activityItem } from '@/lib/category-views'
import { spendByCategory } from '@/lib/budget'
import { monthlyFlows } from '@/lib/dashboard'
import { spendableAmount } from '@/lib/reimbursements'
import { buildSpendContext } from '@/lib/spend-context'
import { kindOf } from '@/lib/category-rules'
import { DEFAULTS, GROCERY, rule, testData } from './helpers/category-context'

// #28 spec §7.2. These used to sit inline in pages, where nothing tested them. The parity tests
// run the real functions against each other: a Breakdown row and the list it opens must add up.
const r = (id: string, month: string, merchant_name: string | null, amount: number, pfc_primary: string | null, over: Record<string, unknown> = {}) => ({
  id, date: `${month}-10`, amount, merchant_name, user_category: null as string | null, pfc_primary,
  pfc_detailed: null as string | null, reimbursable_amount: null as number | null, ...over,
})
const ROWS = [
  r('a', '2026-08', 'Safeway', 50, 'FOOD_AND_DRINK'),
  r('b', '2026-08', 'Safeway', -10, 'FOOD_AND_DRINK'),
  r('c', '2026-09', 'Safeway', 70, 'FOOD_AND_DRINK'),
  r('d', '2026-09', 'Starbucks', 6, 'FOOD_AND_DRINK'),
  r('e', '2026-09', 'Acme Payroll', -3000, 'INCOME'),
  r('f', '2026-09', 'Savings', 500, 'TRANSFER_OUT'),
  // An unpicked card payment: Loan Payments by its primary, but in no total and no drill-down.
  r('g', '2026-09', null, 7866.69, 'LOAN_PAYMENTS', { pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' }),
  r('h', '2026-09', 'Mortgage Co', 2100, 'LOAN_PAYMENTS'),
  r('i', '2026-09', 'Safeway', 12, 'FOOD_AND_DRINK', { user_category: 'Travel' }),
  r('j', '2026-09', 'Rental', 400, 'TRAVEL', { reimbursable_amount: 400 }),
]
const MONTHS = ['2026-08', '2026-09']
const data = testData(DEFAULTS, [rule('Safeway', GROCERY.id)])
const ctx = buildSpendContext({ data, txns: ROWS })
const inMonth = (m: string) => ROWS.filter((t) => t.date.startsWith(m))
const sum = (rows: typeof ROWS) => rows.reduce((s, t) => s + spendableAmount(t, ctx.reimbursedByTxn), 0)

describe('filterByCategory', () => {
  it('adds up to spendByCategory for every spending category and month', () => {
    for (const m of MONTHS) {
      const byCat = spendByCategory(inMonth(m), ctx)
      for (const c of DEFAULTS.filter((c) => kindOf(c.name, ctx) === 'spending')) {
        expect(sum(filterByCategory(inMonth(m), c.name, ctx)), `${c.name} ${m}`).toBeCloseTo(byCat[c.name] ?? 0, 2)
      }
    }
  })

  it('adds up to monthlyFlows income over the income categories', () => {
    const flows = monthlyFlows(ROWS, ctx, MONTHS.map((key) => ({ key, label: key })))
    for (const [i, m] of MONTHS.entries()) {
      const incomeCats = DEFAULTS.filter((c) => kindOf(c.name, ctx) === 'income')
      const total = incomeCats.reduce(
        (s, c) => s - sum(filterByCategory(inMonth(m), c.name, ctx).filter((t) => spendableAmount(t, ctx.reimbursedByTxn) < 0)),
        0
      )
      expect(total).toBeCloseTo(flows[i].income, 2)
    }
  })

  it('leaves the unpicked card payment out of Loan Payments, and keeps the mortgage', () => {
    expect(filterByCategory(ROWS, 'Loan Payments', ctx).map((t) => t.id)).toEqual(['h'])
  })

  it('lists Safeway under Grocery through its rule, and a picked Safeway row under its pick', () => {
    expect(filterByCategory(ROWS, 'Grocery', ctx).map((t) => t.id)).toEqual(['a', 'b', 'c'])
    expect(filterByCategory(ROWS, 'Travel', ctx).map((t) => t.id)).toEqual(['i', 'j'])
  })
})

describe('filterByFlow', () => {
  it('returns the same rows with and without a Safeway → Grocery rule', () => {
    const plain = buildSpendContext({ data: testData(DEFAULTS), txns: ROWS })
    for (const flow of ['in', 'out'] as const) {
      expect(filterByFlow(ROWS, flow, ctx).map((t) => t.id)).toEqual(filterByFlow(ROWS, flow, plain).map((t) => t.id))
    }
  })

  it('splits as monthlyFlows does: no transfers, no card payments, no fully reimbursed rows', () => {
    expect(filterByFlow(ROWS, 'in', ctx).map((t) => t.id)).toEqual(['e'])
    expect(filterByFlow(ROWS, 'out', ctx).map((t) => t.id)).toEqual(['a', 'b', 'c', 'd', 'h', 'i'])
  })
})

describe('activityItem', () => {
  it('labels a Safeway row Grocery', () => {
    const t = { ...ROWS[2], name: 'SAFEWAY #123' }
    expect(activityItem(t, ctx)).toMatchObject({ id: 'c', date: '2026-09-10', category: 'Grocery' })
  })
})
```

- [ ] **Step 2: Run them.** `npx vitest run tests/unit/category-views.test.ts`. Expected: FAIL, the module does not exist.

- [ ] **Step 3: Implement.** Create `lib/category-views.ts`:

```ts
// Category logic the pages used to do inline, where no test could reach it (#28 spec §7.2). Pure.
// Every function resolves through resolveCategory, so a rule relabels a row the same way in a
// list, a filter, a count and a total.
import { isCreditCardPayment } from './categories'
import { kindOf, resolveCategory, type CategorizableTxn, type CategoryContext } from './category-rules'
import { spendableAmount, type ReimbursableTxn } from './reimbursements'
import type { SpendContext } from './spend-context'
import { presentTransaction } from './transaction-presentation'

// The rows a category drill-down lists. Skips unpicked card payments, as spendByCategory does, so
// a Breakdown row and the list it opens add up (they display as "Card payment" and count in no
// total). Card payments still appear in the unfiltered list.
export function filterByCategory<T extends CategorizableTxn>(rows: T[], name: string, ctx: CategoryContext): T[] {
  return rows.filter((t) => !isCreditCardPayment(t) && resolveCategory(t, ctx).name === name)
}

// The rows behind Money in / Money out, matching monthlyFlows exactly: no card payments, no
// transfers, and netted through spendableAmount, so a fully reimbursable row (either direction)
// is in neither list. Money in is an income-category inflow; Money out is everything else that
// counts, refunds included, because a refund nets spending down.
export function filterByFlow<T extends CategorizableTxn & ReimbursableTxn>(
  rows: T[],
  flow: 'in' | 'out',
  ctx: SpendContext
): T[] {
  return rows.filter((t) => {
    if (isCreditCardPayment(t)) return false
    const kind = kindOf(resolveCategory(t, ctx).name, ctx)
    if (kind === 'transfer') return false
    const amt = spendableAmount(t, ctx.reimbursedByTxn)
    if (amt === 0) return false
    return flow === 'in' ? kind === 'income' && amt < 0 : kind !== 'income'
  })
}

// One Recent activity entry on the dashboard. Meaning (label, sign, tone, the card-payment
// exemption) comes from presentTransaction; the category from resolveCategory.
export function activityItem(
  t: Parameters<typeof presentTransaction>[0] & CategorizableTxn & { id: string; date: string },
  ctx: CategoryContext
) {
  const p = presentTransaction(t)
  return {
    id: t.id,
    date: t.date,
    category: resolveCategory(t, ctx).name,
    label: p.label,
    display: p.display,
    tone: p.tone,
    isInternal: p.isInternal,
  }
}
```

If `filterByFlow`'s 'out' expectation in the test fails on row `j` (a fully reimbursable row), that is the test catching a real regression: the old inline filter dropped `amt === 0` rows too. Fix the code, not the expectation.

- [ ] **Step 4: Wire the pages.**
  - **Transactions:** import `filterByCategory`, `filterByFlow`; delete `RealRow` and both casts; `const rows = txns ?? []`; `const ctx = buildSpendContext({ data, txns: rows })`; `let list = rows`; `if (category) list = filterByCategory(list, category, ctx)`; `if (flow === 'in' || flow === 'out') list = filterByFlow(list, flow, ctx)`. Move the old flow comment's substance (the flow=in reconciliation story) onto `filterByFlow` if it isn't already said there. Remove the now-unused `isCreditCardPayment`, `spendableAmount` and `kindOf` imports. If removing `RealRow` makes `accountNameById.get(t.account_id)` or the row props fail tsc, the select's inferred type is the problem: report it, and keep `RealRow` as a *type annotation on `rows`* (`const rows: RealRow[] = txns ?? []`, plus `merchant_name` in `RealRow`), never as an `as` cast.
  - **Dashboard:** `const recentItems = (recentTxns ?? []).map((t) => activityItem(t, ctx))`, deleting the inline map and its `presentTransaction` cast; keep its "one source of meaning" comment on `activityItem`.

- [ ] **Step 5: Page tests.**
  - `transactions-page.test.tsx`: set `results.categories` to `[FOOD, GROCERY]` (as in Task 5) and `results.category_rules` to `[SAFEWAY_RULE]`; add a row `txn({ id: 't4', merchant_name: 'Safeway' })` (Food & Drink by its primary). "files Safeway under Grocery through its rule": render with `{ category: 'Grocery', month: '2026-08' }` and expect the `TransactionRow` keys to be `['t4']`. "leaves the card payment out of a category drill-down": render with `{ category: 'Loan Payments', month: '2026-08' }` with `results.categories` also holding `{ id: 'c-loans', name: 'Loan Payments', pfc_primary: 'LOAN_PAYMENTS', sort_order: 2 }`; expect no rows. The existing categoryName assertions now expect `['Food & Drink', 'Grocery', 'Uncategorized']`-shaped values only where the fixture changed; update them to the names the new fixture resolves to.
  - `dashboard-page.test.tsx`: "labels Safeway Grocery in Recent activity": `results.categories = { data: [FOOD, GROCERY], error: null }`, `results.category_rules = { data: [SAFEWAY_RULE], error: null }`, and a recent-transactions row for Safeway; expect `RecentActivity`'s `items[0].category` to be `'Grocery'`. Find the props the way the file already finds `RecentActivity`.

- [ ] **Step 6: Run everything.** `npx vitest run && npx tsc --noEmit && npm run check:invariants`. Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add lib/category-views.ts app tests
git commit -m "Move category filters and recent activity into tested functions (#28)"
```

---

### Task 7: Settings counts, the delete dialog, and Settings' failure state (spec §7.2, §7.3, §8.4)

**Files:**
- Modify: `lib/category-views.ts` (add `categoryUsage`, `deleteImpact`)
- Modify: `app/(app)/settings/page.tsx`, `components/CategoryManager.tsx`
- Test: `tests/unit/category-views.test.ts`, `tests/unit/settings-page.test.tsx`, `tests/unit/category-manager.test.tsx`

**Interfaces:**
- Consumes: `CountTxn`, `fetchCategoryContext`, `readTransactionsForCounts` (Task 4); Task 3's builders.
- Produces:
  - `type RuleCounts = { changed: number; pickedByHand: number; matching: number }`
  - `categoryUsage(rows: CategorizableTxn[], data: CategoryData, budgetNames: Set<string>): { categories: Record<string, { txns: number; hasBudget: boolean }>; rules: Record<string, RuleCounts> }`
  - `type DeleteImpact = { uncategorized: number; moved: { name: string; count: number }[]; movedMore: number; rulesRemoved: number; toSpending: number }`
  - `deleteImpact(rows: CategorizableTxn[], data: CategoryData, categoryId: string): DeleteImpact`
  - `CategoryUsage` (in `components/CategoryManager.tsx`) becomes `Record<string, { txns: number; hasBudget: boolean; impact: DeleteImpact }>`.
  - Settings computes `CategorySettings = { categories: Category[]; usage: CategoryUsage; rules: RuleView[]; ruleCategories: RuleCategory[] } | null`. Task 9 renders `rules` and `ruleCategories`; in this task the page computes them and Task 9 adds the card.

- [ ] **Step 1: Write the failing view tests.** Append to `tests/unit/category-views.test.ts` (merge imports: `categoryUsage`, `deleteImpact`, `cat`):

```ts
describe('categoryUsage', () => {
  it("counts each category's rows exactly as its drill-down lists them", () => {
    const { categories } = categoryUsage(ROWS, data, new Set(['Grocery']))
    for (const c of DEFAULTS) {
      expect(categories[c.name].txns, c.name).toBe(filterByCategory(ROWS, c.name, ctx).length)
    }
    expect(categories.Grocery).toEqual({ txns: 3, hasBudget: true })
    expect(categories['Loan Payments'].txns).toBe(1) // the mortgage; the card payment is left out
  })

  it('counts, per rule, the rows it relabels, the hand picks, and every matching row', () => {
    const { rules } = categoryUsage(ROWS, data, new Set())
    expect(rules['r-safeway']).toEqual({ changed: 3, pickedByHand: 1, matching: 4 })
  })

  it('reports a rule with no current rows as matching nothing', () => {
    const d = testData(DEFAULTS, [rule('Gone Market', GROCERY.id)])
    expect(categoryUsage(ROWS, d, new Set()).rules['r-gone market']).toEqual({ changed: 0, pickedByHand: 0, matching: 0 })
  })
})

describe('deleteImpact', () => {
  it("counts a pick of the deleted category as moving to its merchant's rule", () => {
    const rows = [r('p', '2026-09', 'Safeway', 9, 'FOOD_AND_DRINK', { user_category: 'Travel' })]
    const d = testData(DEFAULTS, [rule('Safeway', GROCERY.id)])
    expect(deleteImpact(rows, d, 'c-Travel')).toMatchObject({ uncategorized: 0, moved: [{ name: 'Grocery', count: 1 }] })
  })

  it('never counts a pick of the deleted category as staying', () => {
    const rows = [r('p', '2026-09', 'Nobody', 9, 'TRAVEL', { user_category: 'Travel' })]
    expect(deleteImpact(rows, testData(DEFAULTS), 'c-Travel')).toMatchObject({ uncategorized: 1, moved: [] })
  })

  // Review Focus 5.
  it('counts rule-labelled rows as moving to their bank category', () => {
    expect(deleteImpact(ROWS, data, GROCERY.id)).toMatchObject({ uncategorized: 0, moved: [{ name: 'Food & Drink', count: 3 }], rulesRemoved: 1 })
  })

  it('counts rows that start counting as spending when Transfer Out is deleted', () => {
    expect(deleteImpact(ROWS, data, 'c-Transfer Out')).toMatchObject({ uncategorized: 1, toSpending: 1 })
  })

  it('lists the top three destinations and counts the rest as rows', () => {
    const cats = [...DEFAULTS, cat('A'), cat('B'), cat('C'), cat('D')]
    const rows = ['A', 'A', 'A', 'B', 'B', 'C', 'D', 'D', 'D', 'D'].map((n, i) =>
      r(`x${i}`, '2026-09', `M${n}`, 1, 'GENERAL_MERCHANDISE', { user_category: 'Shopping' })
    )
    const d = testData(cats, ['A', 'B', 'C', 'D'].map((n) => rule(`M${n}`, `c-${n}`)))
    const impact = deleteImpact(rows, d, 'c-Shopping')
    expect(impact.moved).toEqual([{ name: 'D', count: 4 }, { name: 'A', count: 3 }, { name: 'B', count: 2 }])
    expect(impact.movedMore).toBe(1)
  })
})
```

- [ ] **Step 2: Run them.** `npx vitest run tests/unit/category-views.test.ts`. Expected: FAIL, not exported.

- [ ] **Step 3: Implement.** Append to `lib/category-views.ts` (merge imports: `buildCategoryContext`, `changedByRule`, `merchantKey`, `type CategoryData`):

```ts
export type RuleCounts = {
  changed: number // rows this rule relabels (changedByRule)
  pickedByHand: number // the merchant's rows that carry a hand pick
  matching: number // every row with the rule's merchant key; 0 shows "No current transactions"
}

// Settings' counts. Per category: how many rows show it, matching its drill-down exactly (so card
// payments without a pick are skipped, as filterByCategory skips them). Per rule: the counts the
// Category rules card shows. Takes CategoryData, not a context, because the per-rule counts need
// each rule's merchant key and a context deliberately hides its rules.
export function categoryUsage(
  rows: CategorizableTxn[],
  data: CategoryData,
  budgetNames: Set<string>
): { categories: Record<string, { txns: number; hasBudget: boolean }>; rules: Record<string, RuleCounts> } {
  const ctx = buildCategoryContext(data)
  const categories: Record<string, { txns: number; hasBudget: boolean }> = {}
  for (const c of data.categories) categories[c.name] = { txns: 0, hasBudget: budgetNames.has(c.name) }
  const rules: Record<string, RuleCounts> = {}
  const ruleIdByKey = new Map<string, string>()
  for (const r of data.rules) {
    rules[r.id] = { changed: 0, pickedByHand: 0, matching: 0 }
    ruleIdByKey.set(r.merchant_key, r.id)
  }
  for (const t of rows) {
    if (isCreditCardPayment(t)) continue
    const resolved = resolveCategory(t, ctx)
    if (Object.hasOwn(categories, resolved.name)) categories[resolved.name].txns++
    if (resolved.ruleId && changedByRule(resolved)) rules[resolved.ruleId].changed++
    const key = merchantKey(t.merchant_name)
    const ruleId = key ? ruleIdByKey.get(key) : undefined
    if (ruleId) {
      rules[ruleId].matching++
      if (t.user_category) rules[ruleId].pickedByHand++
    }
  }
  return { categories, rules }
}

export type DeleteImpact = {
  uncategorized: number
  moved: { name: string; count: number }[] // the top three destinations, by count
  movedMore: number // ROWS moving anywhere else
  rulesRemoved: number
  toSpending: number // rows whose kind becomes spending
}

// What deleting a category would do to each row, for the delete dialog (spec §8.4). Evaluates
// EVERY row, not only those showing the category: deleting a category can also expose another
// category that shares its Plaid primary. "After" mirrors the DELETE route, which removes the
// category (and, through the FK, its rules) and then clears picks carrying its name.
export function deleteImpact(rows: CategorizableTxn[], data: CategoryData, categoryId: string): DeleteImpact {
  const deleted = data.categories.find((c) => c.id === categoryId)
  const rulesRemoved = data.rules.filter((r) => r.category_id === categoryId).length
  if (!deleted) return { uncategorized: 0, moved: [], movedMore: 0, rulesRemoved, toSpending: 0 }
  const before = buildCategoryContext(data)
  const after = buildCategoryContext(data, { withoutCategoryId: categoryId })
  const destinations = new Map<string, number>()
  let uncategorized = 0
  let toSpending = 0
  for (const t of rows) {
    if (isCreditCardPayment(t)) continue
    const b = resolveCategory(t, before)
    const a = resolveCategory({ ...t, user_category: t.user_category === deleted.name ? null : t.user_category }, after)
    if (a.name === b.name) continue
    if (a.name === 'Uncategorized') uncategorized++
    else destinations.set(a.name, (destinations.get(a.name) ?? 0) + 1)
    if (kindOf(b.name, before) !== 'spending' && kindOf(a.name, after) === 'spending') toSpending++
  }
  const ranked = [...destinations]
    .map(([name, count]) => ({ name, count }))
    .sort((x, y) => y.count - x.count || x.name.localeCompare(y.name))
  return {
    uncategorized,
    moved: ranked.slice(0, 3),
    movedMore: ranked.slice(3).reduce((s, m) => s + m.count, 0),
    rulesRemoved,
    toSpending,
  }
}
```

- [ ] **Step 4: Run them.** Same command. Expected: PASS.

- [ ] **Step 5: Write the failing Settings and dialog tests.**

In `tests/unit/settings-page.test.tsx` (merge imports: `BankList`, `CategoryManager`), add an `alertText(tree)` helper beside `findProps` that walks the tree the same way and returns the children of the first element whose `props.role === 'alert'`, and replace the "#69" describe with:

```ts
describe('Settings categories and rules', () => {
  it('counts every transaction, past the 1,000-row cap', async () => {
    results.categories = { data: [{ id: 'c1', name: 'Groceries', pfc_primary: 'FOOD_AND_DRINK', sort_order: 0 }], error: null }
    results.transactions = {
      data: txnRows(1366, '2025-10-18', { merchant_name: null, user_category: 'Groceries', pfc_primary: 'FOOD_AND_DRINK', pfc_detailed: null }),
      error: null,
    }
    const props = findProps(await SettingsPage(), CategoryManager) as { usage: Record<string, { txns: number }> }
    expect(props.usage.Groceries.txns).toBe(1366)
  })

  it('hands the delete dialog what a delete would move', async () => {
    results.categories = { data: [FOOD, GROCERY], error: null }
    results.category_rules = { data: [SAFEWAY_RULE], error: null }
    results.transactions = { data: [{ id: 't1', date: '2026-09-10', merchant_name: 'Safeway', user_category: null, pfc_primary: 'FOOD_AND_DRINK', pfc_detailed: null }], error: null }
    const props = findProps(await SettingsPage(), CategoryManager) as { usage: Record<string, { impact: unknown }> }
    expect(props.usage.Grocery.impact).toMatchObject({ moved: [{ name: 'Food & Drink', count: 1 }], rulesRemoved: 1 })
  })

  it.each([
    ['categories', () => (results.categories = { data: null, error: { message: 'boom' } })],
    ['rules', () => (results.category_rules = { data: null, error: { message: 'boom' } })],
    ['transactions', () => (results.transactions = { data: null, error: { message: 'boom' } })],
    ['budgets', () => (results.budgets = { data: null, error: { message: 'boom' } })],
  ])('keeps Banks usable and shows an alert when the %s read fails', async (_name, fail) => {
    fail()
    const tree = await SettingsPage()
    expect(findProps(tree, BankList)).not.toBeNull()
    expect(findProps(tree, CategoryManager)).toBeNull()
    expect(alertText(tree)).toContain("Couldn't load categories and rules.")
  })
})
```

(`FOOD`, `GROCERY`, `SAFEWAY_RULE` as defined in Task 5 Step 7. The budgets read goes through the file's `chainFor('budgets')`, so `results.budgets` drives it.)

In `tests/unit/category-manager.test.tsx`, add (adapting to how the file already renders `CategoryManager` and opens a delete dialog):

```ts
const none = { uncategorized: 0, moved: [], movedMore: 0, rulesRemoved: 0, toSpending: 0 }
const usageFor = (impact: Partial<typeof none>, hasBudget = false) => ({
  Grocery: { txns: 3, hasBudget, impact: { ...none, ...impact } },
})

describe('CategoryManager delete dialog', () => {
  it('says which rows become Uncategorized and where the rest move', () => {
    renderManager(usageFor({ uncategorized: 2, moved: [{ name: 'Food & Drink', count: 145 }], movedMore: 4 }))
    openDelete('Grocery')
    expect(screen.getByText(/2 transactions/).closest('p')?.textContent).toBe('2 transactions will become Uncategorized.')
    expect(screen.getByText(/145 transactions/).closest('p')?.textContent).toBe('145 transactions will move to Food & Drink.')
    expect(screen.getByText('And 4 more will move to other categories.')).toBeTruthy()
  })

  it('names the rules a delete removes', () => {
    renderManager(usageFor({ rulesRemoved: 2 }))
    openDelete('Grocery')
    expect(screen.getByText('2 merchant rules that file into Grocery will be removed.')).toBeTruthy()
  })

  it('warns about spending only when rows would start counting as spending', () => {
    renderManager(usageFor({ uncategorized: 1, toSpending: 1 }))
    openDelete('Grocery')
    expect(screen.getByText('1 of these will start counting as spending.')).toBeTruthy()
    cleanup()
    renderManager(usageFor({ uncategorized: 1 }))
    openDelete('Grocery')
    expect(screen.queryByText(/start counting as spending/)).toBeNull()
  })

  it('says nothing moves when nothing does', () => {
    renderManager(usageFor({}))
    openDelete('Grocery')
    expect(screen.getByText('No transactions currently use this category.')).toBeTruthy()
  })
})
```

where `renderManager(usage)` renders `<CategoryManager initialCategories={[{ id: 'c-grocery', name: 'Grocery', pfc_primary: null }]} usage={usage} />` and `openDelete(name)` clicks the button labelled `Delete ${name}`. Update the file's existing usage fixtures to carry `impact: none`.

- [ ] **Step 6: Run them.** `npx vitest run tests/unit/settings-page.test.tsx tests/unit/category-manager.test.tsx`. Expected: FAIL.

- [ ] **Step 7: Implement the dialog.** In `components/CategoryManager.tsx`:

```tsx
import type { DeleteImpact } from '@/lib/category-views'

export type CategoryUsage = Record<string, { txns: number; hasBudget: boolean; impact: DeleteImpact }>
```

The default for a missing entry becomes `{ txns: 0, hasBudget: false, impact: { uncategorized: 0, moved: [], movedMore: 0, rulesRemoved: 0, toSpending: 0 } }`, and `CategoryRow`'s `usage` prop takes the new shape. Replace the dialog's body:

```tsx
        <DeleteImpactLines name={cat.name} impact={usage.impact} />
        {usage.hasBudget && <p>Its monthly budget will be deleted.</p>}
        <p>This can’t be undone.</p>
```

and add below `CategoryRow`:

```tsx
const txns = (n: number) => `${n} transaction${n === 1 ? '' : 's'}`

// What deleting this category would actually do (#28 spec §8.4), from deleteImpact. It used to say
// every row "will become Uncategorized", which was wrong for hand picks (they take their merchant's
// rule, or their bank category) and would be wrong again for rule-labelled rows.
function DeleteImpactLines({ name, impact }: { name: string; impact: DeleteImpact }) {
  const moving = impact.uncategorized + impact.moved.reduce((s, m) => s + m.count, 0) + impact.movedMore
  return (
    <>
      {moving === 0 && <p>No transactions currently use this category.</p>}
      {impact.uncategorized > 0 && (
        <p>
          <strong className="font-semibold text-ink">{txns(impact.uncategorized)}</strong> will become Uncategorized.
        </p>
      )}
      {impact.moved.map((m) => (
        <p key={m.name}>
          <strong className="font-semibold text-ink">{txns(m.count)}</strong> will move to {m.name}.
        </p>
      ))}
      {impact.movedMore > 0 && <p>And {impact.movedMore} more will move to other categories.</p>}
      {impact.rulesRemoved > 0 && (
        <p>
          {impact.rulesRemoved} merchant rule{impact.rulesRemoved === 1 ? '' : 's'} that file into {name} will be
          removed.
        </p>
      )}
      {impact.toSpending > 0 && <p>{impact.toSpending} of these will start counting as spending.</p>}
    </>
  )
}
```

- [ ] **Step 8: Implement Settings.** In `app/(app)/settings/page.tsx`, delete the categories read, the `Promise.all`, and the usage loop, and add below the imports (merging them):

```tsx
import { fetchCategoryContext, readTransactionsForCounts } from '@/lib/category-context'
import { buildCategoryContext, kindOf, type Kind } from '@/lib/category-rules'
import { categoryUsage, deleteImpact, type RuleCounts } from '@/lib/category-views'
import type { Category } from '@/lib/categories'

// What the Category rules card shows per rule (Task 9 renders it).
export type RuleView = RuleCounts & {
  id: string
  merchantLabel: string
  categoryId: string
  categoryName: string
  origin: 'seeded' | 'learned'
}
export type RuleCategory = { id: string; name: string; kind: Kind }

type CategorySettings = {
  categories: Category[]
  usage: CategoryUsage
  rules: RuleView[]
  ruleCategories: RuleCategory[]
}

type Supabase = Awaited<ReturnType<typeof createClient>>

async function readBudgetNames(supabase: Supabase): Promise<Set<string>> {
  const { data: budgetRows, error: budgetsError } = await supabase.from('budgets').select('category')
  // Checked (#91): unchecked, a failed read showed every budget as absent in the delete dialog.
  if (budgetsError) throw new Error(`could not read budgets: ${budgetsError.message}`)
  return new Set((budgetRows ?? []).map((b) => b.category as string))
}

// Everything the Categories and Category rules cards need. Throws if any read fails; the page
// catches it, because Settings is the only place a bank can be reconnected (spec §7.3).
async function loadCategorySettings(supabase: Supabase): Promise<CategorySettings> {
  const [data, rows, budgetNames] = await Promise.all([
    fetchCategoryContext(),
    readTransactionsForCounts(),
    readBudgetNames(supabase),
  ])
  const ctx = buildCategoryContext(data)
  const counts = categoryUsage(rows, data, budgetNames)
  const usage: CategoryUsage = {}
  for (const c of data.categories) {
    usage[c.name] = { ...counts.categories[c.name], impact: deleteImpact(rows, data, c.id) }
  }
  const nameById = new Map(data.categories.map((c) => [c.id, c.name]))
  return {
    categories: data.categories,
    usage,
    rules: data.rules.map((r) => ({
      id: r.id,
      merchantLabel: r.merchant_label,
      categoryId: r.category_id,
      // The FK deletes a rule with its category, so a missing name is a race with a delete.
      categoryName: nameById.get(r.category_id) ?? 'a deleted category',
      origin: r.origin,
      ...counts.rules[r.id],
    })),
    ruleCategories: data.categories.map((c) => ({ id: c.id, name: c.name, kind: kindOf(c.name, ctx) })),
  }
}
```

In `SettingsPage`, where the old reads were:

```tsx
  // On Settings alone a failed categories, rules, transactions or budgets read is caught: the
  // Categories and Category rules cards say so, and Household, Banks and Home value still render.
  // No number is shown in their place, so this still honours #46.
  let categorySettings: CategorySettings | null = null
  try {
    categorySettings = await loadCategorySettings(supabase)
  } catch (e) {
    console.error('[settings] could not load categories and rules', e)
  }
```

Add a small component in the same file:

```tsx
function CategoriesUnavailable() {
  return (
    <p role="alert" className="text-sm text-coral">
      Couldn&apos;t load categories and rules.{' '}
      <a href="/settings" className="font-medium underline">
        Try again.
      </a>
    </p>
  )
}
```

The Categories card renders `{categorySettings ? <CategoryManager initialCategories={categorySettings.categories} usage={categorySettings.usage} /> : <CategoriesUnavailable />}`, and its help text becomes: "Rename or delete any category, or add your own. Renames update everywhere. Before you delete one, it shows where that category's transactions will go." Remove the now-unused `effectiveCategory`, `pfcToName`, `readAllRows`, `resolveCategory` imports. (`Try again.` is a plain link so it works in the installed app, which has no browser reload button: #139.)

- [ ] **Step 9: Run everything.** `npx vitest run && npx tsc --noEmit && npm run check:invariants`. Expected: PASS.

- [ ] **Step 10: Commit.**

```bash
git add lib/category-views.ts app/\(app\)/settings/page.tsx components/CategoryManager.tsx tests
git commit -m "Count categories and rules in Settings, and say what a delete moves (#28, closes #91's Settings reads)"
```

---

### Task 8: The category-rules route, and an environment-guarded category delete (spec §6.2, §6.3)

**Files:**
- Create: `app/api/category-rules/route.ts`
- Modify: `app/api/categories/route.ts` (DELETE only)
- Test: `tests/unit/category-rules-route.test.ts`, `tests/unit/categories-route.test.ts`

**Interfaces:**
- Consumes: `buildKindContext`, `kindOf` (Task 3); `assertEnvMatchesDatabase`, `envGuardResponse` (`lib/app-env.ts`).
- Produces:
  - `PATCH /api/category-rules` with `{ id, categoryId, expectedCategoryId }` → `200 { ok: true }` | `400` | `401` | `403` | `404` | `409` | `500` | `503`, `{ error: string }` on failure.
  - `DELETE /api/category-rules` with `{ id, expectedCategoryId }` → `200 { ok: true }` | the same failures.
  - Task 9's card shows `error` verbatim.

Messages, exactly:
- `Choose a category for this rule.` (400, malformed body)
- `Your session ended. Sign in again.` (401)
- `That could not be saved. Please try again.` (500, 503)
- `Your account isn't part of a household.` (403)
- `That rule no longer exists. Refresh and try again.` (404)
- `This rule just changed. Refresh and try again.` (409)
- `That category no longer exists. Refresh and try again.` (400)
- `A rule can only move to a category that counts the same way.` (400)
- Environment: mismatch `This app is pointed at a database from a different environment. Nothing saved.`; unreadable `Could not verify which database this is, so nothing was saved.`

- [ ] **Step 1: Write the failing route tests.** Create `tests/unit/category-rules-route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

// #28 spec §6.2. The stand-in is strict on purpose (a permissive one hid three dead guards here
// before, #99): each write resolves only after the filters the route must apply, and records the
// options it was called with, because stubs otherwise ignore `{ count: 'exact' }`.
const { db, getUser, assertEnvMatchesDatabase } = vi.hoisted(() => ({
  db: {
    membership: { data: { household_id: 'hh-1' }, error: null } as { data: unknown; error: unknown },
    rule: { data: { id: 'r1', category_id: 'c-grocery' }, error: null } as { data: unknown; error: unknown },
    categories: { data: [] as unknown[], error: null } as { data: unknown; error: unknown },
    write: { error: null, count: 1 } as { error: unknown; count: number | null },
    calls: [] as { table: string; op: string; args: unknown[] }[],
  },
  getUser: vi.fn(),
  assertEnvMatchesDatabase: vi.fn(),
}))

function builder(table: string) {
  const filters: string[] = []
  const record = (op: string, args: unknown[]) => db.calls.push({ table, op, args })
  const chain: Record<string, unknown> = {}
  chain.select = (...a: unknown[]) => (record('select', a), chain)
  chain.order = (...a: unknown[]) => (record('order', a), chain)
  chain.limit = () => chain
  chain.eq = (col: string, v: unknown) => {
    filters.push(`${col}=${v}`)
    record('eq', [col, v])
    return chain
  }
  chain.maybeSingle = async () => (table === 'memberships' ? db.membership : db.rule)
  chain.update = (...a: unknown[]) => (record('update', a), chain)
  chain.delete = (...a: unknown[]) => (record('delete', a), chain)
  chain.then = (resolve: (v: unknown) => unknown) => {
    const wrote = db.calls.some((c) => c.table === table && (c.op === 'update' || c.op === 'delete'))
    if (!wrote) return Promise.resolve(table === 'categories' ? db.categories : { data: [], error: null }).then(resolve)
    // A write resolves only when filtered on BOTH the rule id and the category it expected.
    const guarded = filters.includes('id=r1') && filters.some((f) => f.startsWith('category_id='))
    return Promise.resolve(guarded ? db.write : { error: null, count: 0 }).then(resolve)
  }
  return chain
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser }, from: (t: string) => builder(t) }),
}))
vi.mock('@/lib/plaid', () => ({ plaidEnv: 'sandbox' }))
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: {} }))
vi.mock('@/lib/app-env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/app-env')>()),
  assertEnvMatchesDatabase,
}))

import { EnvMismatchError } from '@/lib/app-env'
import { PATCH, DELETE } from '@/app/api/category-rules/route'

const CATS = [
  { id: 'c-food', name: 'Food & Drink', pfc_primary: 'FOOD_AND_DRINK', sort_order: 0 },
  { id: 'c-grocery', name: 'Grocery', pfc_primary: null, sort_order: 1 },
  { id: 'c-income', name: 'Income', pfc_primary: 'INCOME', sort_order: 2 },
]
const req = (method: string, body: unknown) =>
  new Request('http://localhost/api/category-rules', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
const change = (body: Record<string, unknown> = {}) => PATCH(req('PATCH', { id: 'r1', categoryId: 'c-food', expectedCategoryId: 'c-grocery', ...body }))
const remove = (body: Record<string, unknown> = {}) => DELETE(req('DELETE', { id: 'r1', expectedCategoryId: 'c-grocery', ...body }))
const writes = () => db.calls.filter((c) => c.op === 'update' || c.op === 'delete')
const error = async (res: Response) => (await res.json()).error

beforeEach(() => {
  db.membership = { data: { household_id: 'hh-1' }, error: null }
  db.rule = { data: { id: 'r1', category_id: 'c-grocery' }, error: null }
  db.categories = { data: CATS, error: null }
  db.write = { error: null, count: 1 }
  db.calls = []
  getUser.mockResolvedValue({ data: { user: { id: 'u1' } }, error: null })
  assertEnvMatchesDatabase.mockReset().mockResolvedValue(undefined)
})

describe('PATCH /api/category-rules (Change)', () => {
  it('moves a rule to a same-kind category, guarded on the category it expected', async () => {
    const res = await change()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    const [w] = writes()
    expect(w.args[0]).toMatchObject({ category_id: 'c-food' })
    expect(typeof (w.args[0] as { updated_at: unknown }).updated_at).toBe('string')
    expect(w.args[1]).toEqual({ count: 'exact' })
    expect(db.calls).toContainEqual({ table: 'category_rules', op: 'eq', args: ['category_id', 'c-grocery'] })
  })

  it('reads the categories of the caller\'s household, in order', async () => {
    await change()
    expect(db.calls).toContainEqual({ table: 'categories', op: 'eq', args: ['household_id', 'hh-1'] })
    expect(db.calls).toContainEqual({ table: 'categories', op: 'order', args: ['sort_order'] })
  })

  it('answers 200 without writing when the category is unchanged', async () => {
    const res = await change({ categoryId: 'c-grocery' })
    expect(res.status).toBe(200)
    expect(writes()).toHaveLength(0)
  })

  it('answers 404 for a missing rule and 409 for a stale expected category', async () => {
    db.rule = { data: null, error: null }
    expect((await change()).status).toBe(404)
    db.rule = { data: { id: 'r1', category_id: 'c-food' }, error: null }
    const res = await change()
    expect(res.status).toBe(409)
    expect(await error(res)).toBe('This rule just changed. Refresh and try again.')
    expect(writes()).toHaveLength(0)
  })

  it('answers 409 when the expected category was deleted between reads', async () => {
    db.categories = { data: CATS.filter((c) => c.id !== 'c-grocery'), error: null }
    expect((await change()).status).toBe(409)
  })

  it('refuses a cross-kind Change and an unknown target', async () => {
    const cross = await change({ categoryId: 'c-income' })
    expect(cross.status).toBe(400)
    expect(await error(cross)).toBe('A rule can only move to a category that counts the same way.')
    const unknown = await change({ categoryId: 'c-nope' })
    expect(unknown.status).toBe(400)
    expect(await error(unknown)).toBe('That category no longer exists. Refresh and try again.')
    expect(writes()).toHaveLength(0)
  })

  it('answers 409 on a zero count and on 23503, and 500 on any other write error, without database text', async () => {
    db.write = { error: null, count: 0 }
    expect((await change()).status).toBe(409)
    db.write = { error: { code: '23503', message: 'violates foreign key' }, count: null }
    expect((await change()).status).toBe(409)
    db.write = { error: { code: 'XX000', message: 'internal db words' }, count: null }
    const res = await change()
    expect(res.status).toBe(500)
    expect(await error(res)).toBe('That could not be saved. Please try again.')
  })

  it('answers 500 on a failed rule or categories read', async () => {
    db.rule = { data: null, error: { message: 'boom' } }
    expect((await change()).status).toBe(500)
    db.rule = { data: { id: 'r1', category_id: 'c-grocery' }, error: null }
    db.categories = { data: null, error: { message: 'boom' } }
    expect((await change()).status).toBe(500)
  })

  it('answers 400 on a malformed body without touching the database', async () => {
    expect((await PATCH(req('PATCH', '{not json'))).status).toBe(400)
    expect((await change({ categoryId: '' })).status).toBe(400)
    expect(db.calls).toHaveLength(0)
  })
})

describe('DELETE /api/category-rules (Remove)', () => {
  it('deletes guarded on the category it expected, with an exact count', async () => {
    const res = await remove()
    expect(res.status).toBe(200)
    const [w] = writes()
    expect(w.op).toBe('delete')
    expect(w.args[0]).toEqual({ count: 'exact' })
    expect(db.calls).toContainEqual({ table: 'category_rules', op: 'eq', args: ['category_id', 'c-grocery'] })
  })

  it('answers 409 on a zero count and 500 on an error', async () => {
    db.write = { error: null, count: 0 }
    expect((await remove()).status).toBe(409)
    db.write = { error: { message: 'boom' }, count: null }
    expect((await remove()).status).toBe(500)
  })
})

describe.each([
  ['PATCH', () => change()],
  ['DELETE', () => remove()],
])('%s guards', (_m, call) => {
  it('answers 401 signed out, 503 when auth is unreachable, and 403 without a household', async () => {
    getUser.mockResolvedValueOnce({ data: { user: null }, error: null })
    expect((await call()).status).toBe(401)
    const { AuthRetryableFetchError } = await import('@supabase/supabase-js')
    getUser.mockResolvedValueOnce({ data: { user: null }, error: new AuthRetryableFetchError('down', 0) })
    expect((await call()).status).toBe(503)
    db.membership = { data: null, error: null }
    const res = await call()
    expect(res.status).toBe(403)
    expect(await error(res)).toBe("Your account isn't part of a household.")
  })

  it("answers the environment guard's 409 and 500, and writes nothing", async () => {
    assertEnvMatchesDatabase.mockRejectedValueOnce(new EnvMismatchError('sandbox', 'production'))
    expect((await call()).status).toBe(409)
    assertEnvMatchesDatabase.mockRejectedValueOnce(new Error('could not read app_env'))
    expect((await call()).status).toBe(500)
    expect(writes()).toHaveLength(0)
    expect(db.calls.some((c) => c.table === 'category_rules')).toBe(false)
  })
})
```

If `AuthRetryableFetchError`'s constructor signature differs in the installed `@supabase/supabase-js`, construct it the way `tests/unit/categorize-route.test.ts` does; that file already tests the 503 path.

Create `tests/unit/categories-route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

// #28 spec §6.3: deleting a category now deletes its rules through the FK, in the database every
// environment shares. So DELETE is environment-guarded, before ANY read or write.
const { calls, getUser, assertEnvMatchesDatabase } = vi.hoisted(() => ({
  calls: [] as string[],
  getUser: vi.fn(),
  assertEnvMatchesDatabase: vi.fn(),
}))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser },
    from: (table: string) => {
      calls.push(table)
      const chain: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'update', 'delete']) chain[m] = () => chain
      chain.single = async () => ({ data: { name: 'Grocery' }, error: null })
      chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve)
      return chain
    },
  }),
}))
vi.mock('@/lib/plaid', () => ({ plaidEnv: 'sandbox' }))
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: {} }))
vi.mock('@/lib/app-env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/app-env')>()),
  assertEnvMatchesDatabase,
}))

import { EnvMismatchError } from '@/lib/app-env'
import { DELETE } from '@/app/api/categories/route'

const del = () =>
  DELETE(new Request('http://localhost/api/categories', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'c-grocery' }) }))

beforeEach(() => {
  calls.length = 0
  getUser.mockResolvedValue({ data: { user: { id: 'u1' } } })
  assertEnvMatchesDatabase.mockReset().mockResolvedValue(undefined)
})

describe('DELETE /api/categories environment guard', () => {
  it('answers 409 on a mismatch and touches no table', async () => {
    assertEnvMatchesDatabase.mockRejectedValue(new EnvMismatchError('sandbox', 'production'))
    expect((await del()).status).toBe(409)
    expect(calls).toEqual([])
  })

  it('answers 500 when the environment cannot be read, and touches no table', async () => {
    assertEnvMatchesDatabase.mockRejectedValue(new Error('could not read app_env'))
    expect((await del()).status).toBe(500)
    expect(calls).toEqual([])
  })

  it('deletes as before once the guard passes', async () => {
    expect((await del()).status).toBe(200)
    expect(calls).toEqual(['categories', 'categories', 'transactions', 'budgets'])
  })
})
```

- [ ] **Step 2: Run them.** `npx vitest run tests/unit/category-rules-route.test.ts tests/unit/categories-route.test.ts`. Expected: FAIL (no route; no guard).

- [ ] **Step 3: Implement the route.** Create `app/api/category-rules/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { isAuthRetryableFetchError } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { assertEnvMatchesDatabase, envGuardResponse } from '@/lib/app-env'
import { buildKindContext, kindOf } from '@/lib/category-rules'

// Settings → Category rules: Change (PATCH) and Remove (DELETE). #28 spec §6.2. No POST: creating a
// rule from scratch is out of scope; rules come from the seed and, from PR 3, from a first pick.
//
// The client always sends the category it was SHOWING (`expectedCategoryId`), and every write is
// filtered on it, so an action applies only to the rule the person saw. Every message may be shown
// verbatim (CategoryRulesCard does); the database's words go to the log.
//
// Environment-guarded: one database serves local, Preview and production, and a rule written from
// a sandbox session would relabel production's transactions.
const TRY_AGAIN = 'That could not be saved. Please try again.'
const RULE_CHANGED = 'This rule just changed. Refresh and try again.'
const ENV_MESSAGES = {
  tag: '[category-rules]',
  mismatch: 'This app is pointed at a database from a different environment. Nothing saved.',
  unreadable: 'Could not verify which database this is, so nothing was saved.',
}

type Supabase = Awaited<ReturnType<typeof createClient>>
const fail = (status: number, error: string) => NextResponse.json({ error }, { status })
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

// Sign-in, household and environment, in that order (401, 403, then the guard's 409/500).
async function authorize(): Promise<{ supabase: Supabase; householdId: string } | NextResponse> {
  const supabase = await createClient()
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()
  // Only an unreachable Supabase Auth leaves the session's state unknown; see the categorize route.
  if (isAuthRetryableFetchError(authError)) {
    console.error('[category-rules] auth check failed', authError.message)
    return fail(503, TRY_AGAIN)
  }
  if (!user) return fail(401, 'Your session ended. Sign in again.')
  const { data: m, error: mError } = await supabase.from('memberships').select('household_id').limit(1).maybeSingle()
  if (mError) {
    console.error('[category-rules] membership read failed', mError.message)
    return fail(500, TRY_AGAIN)
  }
  if (!m) return fail(403, "Your account isn't part of a household.")
  try {
    await assertEnvMatchesDatabase()
  } catch (e) {
    return envGuardResponse(e, ENV_MESSAGES)
  }
  return { supabase, householdId: m.household_id as string }
}

// Change: move a rule to another category of the SAME kind (spending, transfer or income), so a
// rule never moves money between Spent, Income and Saved.
export async function PATCH(req: Request) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
  const id = text(body?.id)
  const categoryId = text(body?.categoryId)
  const expectedCategoryId = text(body?.expectedCategoryId)
  if (!id || !categoryId || !expectedCategoryId) return fail(400, 'Choose a category for this rule.')

  const auth = await authorize()
  if (auth instanceof NextResponse) return auth
  const { supabase, householdId } = auth

  const { data: rule, error: ruleError } = await supabase
    .from('category_rules')
    .select('id, category_id')
    .eq('id', id)
    .eq('household_id', householdId)
    .maybeSingle()
  if (ruleError) {
    console.error('[category-rules] rule read failed', ruleError.message)
    return fail(500, TRY_AGAIN)
  }
  if (!rule) return fail(404, 'That rule no longer exists. Refresh and try again.')
  if (rule.category_id !== expectedCategoryId) return fail(409, RULE_CHANGED)

  const { data: cats, error: catsError } = await supabase
    .from('categories')
    .select('id, name, pfc_primary, sort_order')
    .eq('household_id', householdId)
    .order('sort_order')
  if (catsError) {
    console.error('[category-rules] categories read failed', catsError.message)
    return fail(500, TRY_AGAIN)
  }
  const categories = cats ?? []
  const current = categories.find((c) => c.id === expectedCategoryId)
  if (!current) return fail(409, RULE_CHANGED) // deleted between the two reads
  const target = categories.find((c) => c.id === categoryId)
  if (!target) return fail(400, 'That category no longer exists. Refresh and try again.')
  const k = buildKindContext(categories)
  if (kindOf(target.name, k) !== kindOf(current.name, k)) {
    return fail(400, 'A rule can only move to a category that counts the same way.')
  }
  if (categoryId === expectedCategoryId) return NextResponse.json({ ok: true })

  // No update trigger on this table (precedent: app/api/manual-assets/route.ts), so updated_at is
  // set here. Filtered on the category the client saw, so a concurrent Change cannot be overwritten.
  const { error, count } = await supabase
    .from('category_rules')
    .update({ category_id: categoryId, updated_at: new Date().toISOString() }, { count: 'exact' })
    .eq('id', id)
    .eq('category_id', expectedCategoryId)
  if (error?.code === '23503') {
    // The target category was deleted between our read and this write.
    console.error('[category-rules] change hit a deleted category', error.message)
    return fail(409, RULE_CHANGED)
  }
  if (error) {
    console.error('[category-rules] change failed', error.message)
    return fail(500, TRY_AGAIN)
  }
  if (!count) return fail(409, RULE_CHANGED)
  console.log('[category-rules] changed', { id, from: current.name, to: target.name })
  return NextResponse.json({ ok: true })
}

// Remove: forget the rule (spec decision 6). Its rows go back to their bank category, hand picks
// keep theirs, and the merchant's next pick teaches again (from PR 3).
export async function DELETE(req: Request) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
  const id = text(body?.id)
  const expectedCategoryId = text(body?.expectedCategoryId)
  if (!id || !expectedCategoryId) return fail(400, 'Choose a category for this rule.')

  const auth = await authorize()
  if (auth instanceof NextResponse) return auth
  const { supabase } = auth

  const { error, count } = await supabase
    .from('category_rules')
    .delete({ count: 'exact' })
    .eq('id', id)
    .eq('category_id', expectedCategoryId)
  if (error) {
    console.error('[category-rules] remove failed', error.message)
    return fail(500, TRY_AGAIN)
  }
  if (!count) return fail(409, RULE_CHANGED)
  console.log('[category-rules] removed', { id, categoryId: expectedCategoryId })
  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 4: Guard the category delete.** In `app/api/categories/route.ts`, import `{ assertEnvMatchesDatabase, envGuardResponse } from '@/lib/app-env'`, and in `DELETE` insert directly after the `if (!user) …` line:

```ts
  // Deleting a category now deletes its rules too (category_rules' FK, #28), and already clears
  // picks and deletes budgets, all in the database local, Preview and production share. So it is
  // guarded before its first read. POST and PATCH touch no rule and stay unguarded.
  try {
    await assertEnvMatchesDatabase()
  } catch (e) {
    return envGuardResponse(e, {
      tag: '[categories]',
      mismatch: 'This app is pointed at a database from a different environment. Nothing deleted.',
      unreadable: 'Could not verify which database this is, so nothing was deleted.',
    })
  }
```

Change the route's header comment for DELETE to: `// Delete a category: its rules go with it (FK), its picks revert to auto, its budget is dropped.`

- [ ] **Step 5: Run them.** Same command as Step 2. Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add app/api/category-rules app/api/categories/route.ts tests/unit/category-rules-route.test.ts tests/unit/categories-route.test.ts
git commit -m "Add Change and Remove for category rules, and guard category deletes by environment (#28)"
```

---

### Task 9: Settings → Category rules (spec §8.3)

**Files:**
- Create: `lib/save-response.ts`, `components/CategoryRulesCard.tsx`
- Modify: `app/(app)/settings/page.tsx`
- Test: `tests/unit/save-response.test.ts`, `tests/unit/category-rules-card.test.tsx`, `tests/unit/settings-page.test.tsx`

**Interfaces:**
- Consumes: `RuleView`, `RuleCategory` (exported from `app/(app)/settings/page.tsx` in Task 7; move both types into `components/CategoryRulesCard.tsx` and import them into the page, since a component should not import from a page); the route from Task 8.
- Produces: `readSaveResponse(res: Response): Promise<{ ok: true } | { ok: false; error: string }>` (throws when an OK JSON reply can't be read); `SESSION_ENDED`, `SAVE_FAILED`, `MAY_NOT_HAVE_SAVED` constants; `CategoryRulesCard({ rules: RuleView[]; categories: RuleCategory[] })`.

- [ ] **Step 1: Write the failing tests.** Create `tests/unit/save-response.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { readSaveResponse, SESSION_ENDED, SAVE_FAILED } from '@/lib/save-response'

// #28 spec §8.2's rule, shared by the rules card: a save counts only when the reply is OK, not
// redirected, and JSON with ok: true.
const res = (o: { ok?: boolean; redirected?: boolean; json?: boolean; body?: unknown; bad?: boolean }) =>
  ({
    ok: o.ok ?? true,
    redirected: o.redirected ?? false,
    headers: new Headers(o.json === false ? { 'content-type': 'text/html' } : { 'content-type': 'application/json' }),
    json: async () => {
      if (o.bad) throw new SyntaxError('bad json')
      return o.body
    },
  }) as unknown as Response

describe('readSaveResponse', () => {
  it('accepts only a JSON ok: true', async () => {
    expect(await readSaveResponse(res({ body: { ok: true } }))).toEqual({ ok: true })
    expect(await readSaveResponse(res({ body: {} }))).toEqual({ ok: false, error: SAVE_FAILED })
  })
  it('reads a redirect, or an OK reply that is not JSON, as an ended session', async () => {
    expect(await readSaveResponse(res({ redirected: true, body: { ok: true } }))).toEqual({ ok: false, error: SESSION_ENDED })
    expect(await readSaveResponse(res({ json: false }))).toEqual({ ok: false, error: SESSION_ENDED })
  })
  it("shows the route's message on a refusal, and a fallback for a non-JSON failure", async () => {
    expect(await readSaveResponse(res({ ok: false, body: { error: 'This rule just changed. Refresh and try again.' } }))).toEqual({
      ok: false,
      error: 'This rule just changed. Refresh and try again.',
    })
    expect(await readSaveResponse(res({ ok: false, json: false }))).toEqual({ ok: false, error: SAVE_FAILED })
  })
  it("throws when the route's own OK reply cannot be read, because it may have saved", async () => {
    await expect(readSaveResponse(res({ bad: true }))).rejects.toThrow('bad json')
  })
})
```

Create `tests/unit/category-rules-card.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { CategoryRulesCard, type RuleView, type RuleCategory } from '@/components/CategoryRulesCard'

const refresh = vi.hoisted(() => vi.fn())
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  refresh.mockClear()
})

const CATS: RuleCategory[] = [
  { id: 'c-food', name: 'Food & Drink', kind: 'spending' },
  { id: 'c-grocery', name: 'Grocery', kind: 'spending' },
  { id: 'c-income', name: 'Income', kind: 'income' },
  { id: 'c-tin', name: 'Transfer In', kind: 'transfer' },
]
const safeway = (over: Partial<RuleView> = {}): RuleView => ({
  id: 'r1', merchantLabel: 'Safeway', categoryId: 'c-grocery', categoryName: 'Grocery', origin: 'seeded',
  changed: 145, pickedByHand: 14, matching: 159, ...over,
})
const reply = (ok: boolean, body: unknown) => ({ ok, redirected: false, headers: new Headers({ 'content-type': 'application/json' }), json: async () => body })

describe('CategoryRulesCard', () => {
  it('offers only categories of the same kind', () => {
    render(<CategoryRulesCard rules={[safeway()]} categories={CATS} />)
    const options = within(screen.getByRole('combobox', { name: 'Category for Safeway' })).getAllByRole('option')
    expect(options.map((o) => o.textContent)).toEqual(['Food & Drink', 'Grocery'])
  })

  // Review Focus 4.
  it('stacks below sm and never truncates the count', () => {
    render(<CategoryRulesCard rules={[safeway({ merchantLabel: 'A very long merchant name that will not fit on a phone' })]} categories={CATS} />)
    const count = screen.getByText('145 transactions · 14 picked by hand')
    expect(count.className).toContain('whitespace-nowrap')
    expect(count.className).toContain('tabular-nums')
    expect(count.closest('.truncate')).toBeNull()
    const label = screen.getByText(/A very long merchant/)
    expect(label.className).toContain('truncate')
    expect(label.getAttribute('title')).toBe('A very long merchant name that will not fit on a phone')
    expect(label.closest('li')?.className).toMatch(/flex-col.*sm:flex-row/)
  })

  it('omits the hand-pick count when it is zero', () => {
    render(<CategoryRulesCard rules={[safeway({ pickedByHand: 0 })]} categories={CATS} />)
    expect(screen.getByText('145 transactions')).toBeTruthy()
  })

  it('shows a rule with no current transactions as such', () => {
    render(<CategoryRulesCard rules={[safeway({ changed: 0, pickedByHand: 0, matching: 0 })]} categories={CATS} />)
    expect(screen.getByText('No current transactions · set up from your earlier picks')).toBeTruthy()
  })

  it('shows the empty state', () => {
    render(<CategoryRulesCard rules={[]} categories={CATS} />)
    expect(screen.getByText('Nothing learned yet. Pick a category on a transaction and the app will remember it for that merchant.')).toBeTruthy()
  })

  it('Changes with the category it was showing, and refreshes', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(true, { ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    render(<CategoryRulesCard rules={[safeway()]} categories={CATS} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'c-food' } })
    await waitFor(() => expect(refresh).toHaveBeenCalled())
    expect(fetchMock).toHaveBeenCalledWith('/api/category-rules', expect.objectContaining({ method: 'PATCH' }))
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ id: 'r1', categoryId: 'c-food', expectedCategoryId: 'c-grocery' })
  })

  it('rolls back with the route message on a refused Change, without refreshing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(false, { error: 'This rule just changed. Refresh and try again.' })))
    render(<CategoryRulesCard rules={[safeway()]} categories={CATS} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'c-food' } })
    expect((await screen.findByRole('alert')).textContent).toBe('This rule just changed. Refresh and try again.')
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('c-grocery')
    expect(refresh).not.toHaveBeenCalled()
  })

  it('rolls back on a redirected Change and says the session ended', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ...reply(true, { ok: true }), redirected: true }))
    render(<CategoryRulesCard rules={[safeway()]} categories={CATS} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'c-food' } })
    expect((await screen.findByRole('alert')).textContent).toBe('Your session ended. Sign in again.')
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('c-grocery')
  })

  it("Remove's dialog omits zero counts and says the next pick teaches", () => {
    render(<CategoryRulesCard rules={[safeway({ pickedByHand: 0 })]} categories={CATS} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remove the Safeway rule' }))
    const dialog = screen.getByRole('dialog', { hidden: true })
    expect(within(dialog).getByText('Remove the Safeway rule?')).toBeTruthy()
    expect(within(dialog).getByText('145 Safeway transactions go back to their bank’s category.')).toBeTruthy()
    expect(within(dialog).queryByText(/picked by hand|keep theirs/)).toBeNull()
    expect(within(dialog).getByText('The next category you pick for Safeway will teach the app again.')).toBeTruthy()
  })

  it("Remove's dialog explains a rule with no current transactions", () => {
    render(<CategoryRulesCard rules={[safeway({ changed: 0, pickedByHand: 0, matching: 0 })]} categories={CATS} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remove the Safeway rule' }))
    const dialog = screen.getByRole('dialog', { hidden: true })
    expect(within(dialog).getByText('No Safeway transactions are showing right now — for example, if a bank is disconnected.')).toBeTruthy()
  })

  it('Removes with the category it was showing', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(true, { ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    render(<CategoryRulesCard rules={[safeway()]} categories={CATS} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remove the Safeway rule' }))
    fireEvent.click(within(screen.getByRole('dialog', { hidden: true })).getByRole('button', { name: 'Remove', hidden: true }))
    await waitFor(() => expect(refresh).toHaveBeenCalled())
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ id: 'r1', expectedCategoryId: 'c-grocery' })
  })
})
```

If jsdom's `<dialog>` needs the same handling `tests/unit/confirm-dialog.test.tsx` uses, follow that file.

- [ ] **Step 2: Run them.** `npx vitest run tests/unit/save-response.test.ts tests/unit/category-rules-card.test.tsx`. Expected: FAIL.

- [ ] **Step 3: Implement `lib/save-response.ts`.**

```ts
// Whether a mutation's reply means it saved (#28 spec §8.2). A signed-out request is redirected to
// /login and fetch follows it to an HTML page: a 200 that saved nothing. So a save counts only
// when the reply is OK, not redirected, and JSON with ok: true. Mirrors CategoryPicker's inline
// handling, which predates this.
export const SAVE_FAILED = 'That could not be saved.'
export const SESSION_ENDED = 'Your session ended. Sign in again.'
// For a request that failed in flight, or whose OK reply could not be read: it may have reached the
// server and written, so "could not be saved" would be a guess. Callers show this and reload.
export const MAY_NOT_HAVE_SAVED = 'It may not have saved. Showing the latest.'

export type SaveResult = { ok: true } | { ok: false; error: string }

// Throws when the route's own OK JSON reply cannot be read: the outcome is unknown, and the caller
// treats it like a request lost in flight.
export async function readSaveResponse(res: Response): Promise<SaveResult> {
  const isJson = (res.headers.get('content-type') ?? '').includes('application/json')
  if (res.redirected || (res.ok && !isJson)) return { ok: false, error: SESSION_ENDED }
  let body: { ok?: unknown; error?: unknown } | null = null
  if (isJson) {
    try {
      body = await res.json()
    } catch (err) {
      if (res.ok) throw err
    }
  }
  if (res.ok && body?.ok === true) return { ok: true }
  return { ok: false, error: typeof body?.error === 'string' ? body.error : SAVE_FAILED }
}
```

- [ ] **Step 4: Implement `components/CategoryRulesCard.tsx`.**

```tsx
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/Button'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { selectClass } from '@/components/ui/styles'
import { MAY_NOT_HAVE_SAVED, readSaveResponse } from '@/lib/save-response'
import type { Kind } from '@/lib/category-rules'
import type { RuleCounts } from '@/lib/category-views'

export type RuleView = RuleCounts & {
  id: string
  merchantLabel: string
  categoryId: string
  categoryName: string
  origin: 'seeded' | 'learned'
}
export type RuleCategory = { id: string; name: string; kind: Kind }

const ORIGIN = { seeded: 'set up from your earlier picks', learned: 'learned from a pick' } as const
const txns = (n: number) => `${n} transaction${n === 1 ? '' : 's'}`

// Settings → Category rules (#28 spec §8.3): every rule, with what it does, a Change of category
// within its kind, and Remove. Rules are created by picking (PR 3) and by the one-time seed, never
// here.
export function CategoryRulesCard({ rules, categories }: { rules: RuleView[]; categories: RuleCategory[] }) {
  const sorted = [...rules].sort((a, b) => a.merchantLabel.localeCompare(b.merchantLabel, undefined, { sensitivity: 'base' }))
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        When you pick a category for a merchant the app hasn&apos;t learned yet, it files that merchant&apos;s other
        transactions the same way, past and future. It never moves money between spending, transfers and income, and
        never touches card payments.
      </p>
      {sorted.length === 0 ? (
        <p className="text-sm text-muted">
          Nothing learned yet. Pick a category on a transaction and the app will remember it for that merchant.
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {sorted.map((r) => (
            <RuleRow key={r.id} rule={r} categories={categories} />
          ))}
        </ul>
      )}
    </div>
  )
}

function RuleRow({ rule, categories }: { rule: RuleView; categories: RuleCategory[] }) {
  const router = useRouter()
  // As CategoryPicker: the choice being saved shows until the save settles; on failure it is
  // dropped and the select falls back to the server's current value. A refresh that brings a new
  // category clears both the choice and any alert.
  const [pending, setPending] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [seen, setSeen] = useState(rule.categoryId)
  if (seen !== rule.categoryId) {
    setSeen(rule.categoryId)
    setPending(null)
    setError(null)
  }

  const current = categories.find((c) => c.id === rule.categoryId)
  // Same kind only: a rule never moves money between spending, transfers and income.
  const options = current ? categories.filter((c) => c.kind === current.kind) : []
  const label = rule.merchantLabel

  async function send(method: 'PATCH' | 'DELETE', body: Record<string, string>): Promise<boolean> {
    setBusy(true)
    setError(null)
    let reload = false
    let saved = false
    try {
      const res = await fetch('/api/category-rules', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const result = await readSaveResponse(res)
      if (result.ok) {
        saved = true
        reload = true
      } else {
        setError(result.error)
      }
    } catch (err) {
      console.error('[CategoryRulesCard] save failed', err)
      setError(MAY_NOT_HAVE_SAVED)
      reload = true
    } finally {
      setBusy(false)
    }
    if (reload) router.refresh()
    return saved
  }

  async function change(e: React.ChangeEvent<HTMLSelectElement>) {
    const categoryId = e.target.value
    setPending(categoryId)
    // No confirmation: picking again undoes it.
    const saved = await send('PATCH', { id: rule.id, categoryId, expectedCategoryId: rule.categoryId })
    if (!saved) setPending(null)
  }

  const count =
    rule.matching === 0
      ? `No current transactions · ${ORIGIN[rule.origin]}`
      : `${txns(rule.changed)}${rule.pickedByHand > 0 ? ` · ${rule.pickedByHand} picked by hand` : ''}`

  return (
    <li className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:gap-3">
      <div className="min-w-0 sm:flex-1">
        <p className="truncate text-sm font-medium text-ink" title={label}>
          {label}
        </p>
        {/* Never inside a truncating element: the count is the point of the row. */}
        <p className="text-xs text-muted">
          <span
            className="whitespace-nowrap tabular-nums"
            title={`Transactions this rule files under ${rule.categoryName} instead of the bank's category`}
          >
            {count}
          </span>
        </p>
      </div>
      <div className="flex items-center gap-2">
        <select
          value={pending ?? rule.categoryId}
          onChange={change}
          disabled={busy}
          aria-label={`Category for ${label}`}
          className={`${selectClass} min-w-0 flex-1 sm:w-48 sm:flex-none`}
        >
          {options.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <Button
          variant="danger"
          size="sm"
          disabled={busy}
          onClick={() => setConfirming(true)}
          aria-label={`Remove the ${label} rule`}
        >
          Remove
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-coral sm:basis-full">
          {error}
        </p>
      )}
      <ConfirmDialog
        open={confirming}
        title={`Remove the ${label} rule?`}
        confirmLabel="Remove"
        busy={busy}
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false)
          void send('DELETE', { id: rule.id, expectedCategoryId: rule.categoryId })
        }}
      >
        {rule.changed > 0 && <p>{rule.changed} {label} transactions go back to their bank’s category.</p>}
        {rule.pickedByHand > 0 && <p>{rule.pickedByHand} you picked by hand keep theirs.</p>}
        {rule.matching === 0 && (
          <p>No {label} transactions are showing right now — for example, if a bank is disconnected.</p>
        )}
        <p>The next category you pick for {label} will teach the app again.</p>
      </ConfirmDialog>
    </li>
  )
}
```

The `sm:basis-full` on the alert only matters in the `sm:flex-row` layout, where it puts the alert on its own line; check in Chromium at 390px and 1280px that the alert sits under the row and nothing overflows. If `flex-row` won't wrap to give it a line, add `sm:flex-wrap` to the `<li>` and keep the test's class assertion matching.

- [ ] **Step 5: Wire Settings.** In `app/(app)/settings/page.tsx`, delete the local `RuleView`/`RuleCategory` types and import them, with the card, from `@/components/CategoryRulesCard`. Below the Categories card add:

```tsx
      <Card id="category-rules" className="scroll-mt-6 p-5 space-y-3">
        <h2 className="text-base font-semibold text-ink">Category rules</h2>
        {categorySettings ? (
          <CategoryRulesCard rules={categorySettings.rules} categories={categorySettings.ruleCategories} />
        ) : (
          <CategoriesUnavailable />
        )}
      </Card>
```

(`scroll-mt-6` so the learned marker's `#category-rules` link doesn't land the heading under the top edge; adjust to the app shell's header height if it has a sticky one: `grep -n "sticky" components/AppShell*.tsx`.)

Add to `tests/unit/settings-page.test.tsx`: "shows each rule with its counts": with the Task 7 fixture plus a hand-picked Safeway row (`user_category: 'Travel'` and a `Travel` category), `findProps(tree, CategoryRulesCard).rules` equals `[expect.objectContaining({ id: 'r-safeway', merchantLabel: 'Safeway', categoryName: 'Grocery', changed: 1, pickedByHand: 1, matching: 2 })]`; and in the failure `it.each`, also expect `findProps(tree, CategoryRulesCard)` to be null.

- [ ] **Step 6: Run everything.** `npx vitest run && npx tsc --noEmit && npm run lint`. Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add lib/save-response.ts components/CategoryRulesCard.tsx app/\(app\)/settings/page.tsx tests
git commit -m "Add Settings → Category rules, with Change and Remove (#28)"
```

---

### Task 10: The learned marker and the `category: ResolvedCategory` prop (spec §8.1, §8.2)

**Files:**
- Modify: `components/ui/icons.tsx` (add `LearnedIcon`)
- Create: `components/LearnedMarker.tsx`
- Modify: `components/CategoryPicker.tsx`, `components/TransactionRow.tsx`, `components/TransactionCard.tsx`, `app/(app)/transactions/page.tsx`
- Test: `tests/unit/category-picker.test.tsx`, `tests/unit/transaction-row.test.tsx`, `tests/unit/transaction-card.test.tsx`, `tests/unit/transactions-page.test.tsx`

**Interfaces:**
- Consumes: `ResolvedCategory`, `changedByRule` (Task 3).
- Produces:
  - `CategoryPicker` gains a required `source: ResolvedCategory['source']` prop; it re-syncs on `` `${source}:${value}` ``.
  - `TransactionRow` and `TransactionCard`: `categoryName: string` becomes `category: ResolvedCategory`.
  - `learnedText(category: string, merchant: string | null): string` and `LearnedMarker({ category, merchant })` in `components/LearnedMarker.tsx`.

- [ ] **Step 1: Write the failing tests.**

`tests/unit/category-picker.test.tsx`: add `source: 'bank' as const` to the shared `props` object, then:

```tsx
  // #28 spec §8.2: keyed on source and value, so a row whose REASON for a name changes (a rule equal
  // to the bank's category is removed: rule → bank, same name) still drops a stale alert.
  it('clears its alert when the source changes and the name does not', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(false, { error: 'This transaction just changed. Refresh and try again.' })))
    const { rerender } = render(<CategoryPicker {...props} source="rule" />)
    fireEvent.change(select(), { target: { value: 'Shopping' } })
    expect(await screen.findByRole('alert')).toBeTruthy()
    rerender(<CategoryPicker {...props} source="bank" />)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(select().value).toBe('Food & Drink')
  })
```

`tests/unit/transaction-row.test.tsx`: change `renderRow` to take a category:

```tsx
import type { ResolvedCategory } from '@/lib/category-rules'

const FOOD: ResolvedCategory = { name: 'Food', source: 'bank', ruleId: null, bankName: 'Food' }
const LEARNED: ResolvedCategory = { name: 'Grocery', source: 'rule', ruleId: 'r1', bankName: 'Food' }

function renderRow(overrides: Partial<typeof txn> = {}, category: ResolvedCategory = FOOD) {
  return render(
    <table>
      <tbody>
        <TransactionRow t={{ ...txn, ...overrides }} category={category} categoryOptions={['Food', 'Grocery']} />
      </tbody>
    </table>
  )
}
```

and add:

```tsx
describe('TransactionRow learned marker (#28)', () => {
  const marker = () => screen.queryByRole('link', { name: /learned from/ })

  it('appears only when a rule changed the name', () => {
    renderRow({}, LEARNED)
    const link = marker()!
    expect(link.getAttribute('href')).toBe('/settings#category-rules')
    expect(link.getAttribute('aria-label')).toBe('Grocery, learned from Joe S Den. Manage in Settings → Category rules.')
    expect(link.getAttribute('title')).toBe(link.getAttribute('aria-label'))
    cleanup()
    renderRow({}, { name: 'Food', source: 'rule', ruleId: 'r1', bankName: 'Food' })
    expect(marker()).toBeNull()
    cleanup()
    renderRow({}, FOOD)
    expect(marker()).toBeNull()
  })

  // Review Focus 3.
  it('a hand pick shows no marker', () => {
    renderRow({ user_category: 'Grocery' }, { name: 'Grocery', source: 'pick', ruleId: null, bankName: 'Food' })
    expect(marker()).toBeNull()
  })

  // Ruling 1: the cell is one horizontal line; only the picker container and the marker sit in it.
  it('keeps the cell to one no-wrap line: the picker container, then the marker', () => {
    const { container } = renderRow({}, LEARNED)
    const cell = container.querySelectorAll('td')[2]
    const line = cell.firstElementChild as HTMLElement
    expect(line.className).toContain('flex-nowrap')
    expect(line.className).toContain('items-start')
    expect(line.children).toHaveLength(2)
    expect((line.children[0] as HTMLElement).className).toMatch(/\bmin-w-0\b.*\bflex-1\b|\bflex-1\b.*\bmin-w-0\b/)
    expect(line.children[0].querySelector('select')).not.toBeNull()
    expect(line.children[1]).toBe(marker())
    expect((line.children[1] as HTMLElement).className).toContain('shrink-0')
  })

  // Review Focus 2.
  it('keeps the marker beside the select while an error shows', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, redirected: false, headers: new Headers({ 'content-type': 'application/json' }), json: async () => ({ error: 'This transaction just changed. Refresh and try again.' }) }))
    const { container } = renderRow({}, LEARNED)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Food' } })
    const alert = await screen.findByRole('alert')
    const line = container.querySelectorAll('td')[2].firstElementChild as HTMLElement
    expect(line.children[0].contains(alert)).toBe(true)
    expect(line.children[1]).toBe(marker())
    vi.unstubAllGlobals()
  })
})
```

(merge `fireEvent` into the file's testing-library import and `vi` into its vitest import; the existing `vi.mock('next/navigation', …)` stays.)

`tests/unit/transaction-card.test.tsx`: replace every `categoryName="X"` with `category={{ name: 'X', source: 'bank', ruleId: null, bankName: 'X' }}` (a local `bank(name)` helper keeps that short), and add:

```tsx
describe('TransactionCard learned marker (#28)', () => {
  const learned = { name: 'Grocery', source: 'rule' as const, ruleId: 'r1', bankName: 'Food' }

  it('says so in the row and its accessible name, without a link inside the button', () => {
    render(<TransactionCard t={txn} category={learned} categoryOptions={['Food', 'Grocery']} />)
    const button = screen.getByRole('button', { name: /learned from Joe S Den/ })
    expect(button.querySelector('a')).toBeNull()
    expect(button.querySelector('svg')).not.toBeNull()
  })

  it('shows where the rule lives in the sheet', () => {
    render(<TransactionCard t={txn} category={learned} categoryOptions={['Food', 'Grocery']} />)
    fireEvent.click(screen.getByRole('button', { name: /edit/ }))
    expect(screen.getByText(/Learned from Joe S Den\./)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Manage in Settings', hidden: true }).getAttribute('href')).toBe('/settings#category-rules')
  })

  // Review Focus 3.
  it('a hand pick shows no marker', () => {
    render(<TransactionCard t={{ ...txn, user_category: 'Grocery' }} category={{ ...learned, source: 'pick', ruleId: null }} categoryOptions={['Food', 'Grocery']} />)
    expect(screen.queryByRole('button', { name: /learned from/ })).toBeNull()
  })
})
```

(`txn` is the file's existing fixture, whose `merchant_name` is 'Joe S Den'; if it differs, use its value.)

`tests/unit/transactions-page.test.tsx`: the assertions on `props?.categoryName` become `props?.category` (`ResolvedCategory`), and add "hands each row its resolved category, source included": with the Task 6 Safeway fixture, the `TransactionRow` for `t4` has `category` equal to `{ name: 'Grocery', source: 'rule', ruleId: 'r-safeway', bankName: 'Food & Drink' }`, and the matching `TransactionCard` has the same `category`.

- [ ] **Step 2: Run them.** `npx vitest run tests/unit/category-picker.test.tsx tests/unit/transaction-row.test.tsx tests/unit/transaction-card.test.tsx tests/unit/transactions-page.test.tsx`. Expected: FAIL.

- [ ] **Step 3: Implement.**

`components/ui/icons.tsx`, append:

```tsx
// "Filed by a learned rule" (#28): a small spark, read at 14px beside a category.
export const LearnedIcon = ({ className }: IconProps) => (
  <Svg className={className}>
    <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
    <path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" />
  </Svg>
)
```

`components/LearnedMarker.tsx`:

```tsx
import Link from 'next/link'
import { LearnedIcon } from './ui/icons'

// The words for a row a merchant rule relabelled (#28 spec §8.1). One string, so the desktop link
// and the phone card cannot describe the same thing differently.
export function learnedText(category: string, merchant: string | null): string {
  return `${category}, learned from ${merchant?.trim() || 'this merchant'}. Manage in Settings → Category rules.`
}

// Beside the desktop picker. shrink-0, and the same height as the desktop select (py-1.5 + a 20px
// line + a 2px border = 34px) so the icon centres on it, while the cell's items-start keeps it at
// the top when a save error grows the picker's column.
export function LearnedMarker({ category, merchant }: { category: string; merchant: string | null }) {
  const text = learnedText(category, merchant)
  return (
    <Link
      href="/settings#category-rules"
      title={text}
      aria-label={text}
      className="flex h-[34px] shrink-0 items-center rounded text-faint transition-colors hover:text-emerald focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald/40"
    >
      <LearnedIcon className="h-3.5 w-3.5" />
    </Link>
  )
}
```

`components/CategoryPicker.tsx`:
- import `type { ResolvedCategory } from '@/lib/category-rules'`; add `source: ResolvedCategory['source']` to the props (after `value`), with the comment `// Why the server shows \`value\`: a pick, a rule or the bank. Part of the re-sync key below.`
- replace the follow-the-server block:

```tsx
  // Follow the server. When a refresh brings a new value, or the same name for a new reason (a rule
  // equal to the bank's category is removed: rule → bank), show it and drop any optimistic choice
  // or alert. React's documented way to adjust state when a prop changes; the same idiom as
  // components/ReimbursableCheckbox.tsx.
  const serverKey = `${source}:${value}`
  const [seen, setSeen] = useState(serverKey)
  if (seen !== serverKey) {
    setSeen(serverKey)
    setPending(null)
    setError(null)
  }
```

`components/TransactionRow.tsx`:
- props: `category: ResolvedCategory` replaces `categoryName: string`; import `changedByRule`, `type ResolvedCategory` from `@/lib/category-rules` and `LearnedMarker` from `./LearnedMarker`.
- the non-card-payment branch of the Category cell becomes:

```tsx
          // One horizontal line (#28 spec §8.1, plan Ruling 1): the picker fills what the marker
          // leaves, and the marker never wraps under it. items-start: a save error shows under the
          // select and grows this one row (PR 1), and the marker stays beside the select, not
          // centred on the taller cell.
          <span className="flex min-w-0 flex-nowrap items-start gap-1.5">
            <span className="min-w-0 flex-1">
              <CategoryPicker
                transactionId={t.id}
                value={category.name}
                source={category.source}
                options={categoryOptions}
                label={label}
              />
            </span>
            {changedByRule(category) && <LearnedMarker category={category.name} merchant={t.merchant_name} />}
          </span>
```

`components/TransactionCard.tsx`:
- props: `category: ResolvedCategory` replaces `categoryName`; import `changedByRule`, `type ResolvedCategory`, `learnedText` and `LearnedIcon`, and `Link` from `next/link`.
- `const categoryLabel = cardPayment ? (t.user_category ?? 'Card payment') : category.name`
- `const learned = !cardPayment && changedByRule(category)`
- `const merchant = t.merchant_name?.trim() || 'this merchant'`
- the button's `aria-label` becomes `` `${name}, ${categoryLabel}${learned ? `, learned from ${merchant}` : ''}, ${money(display)}${shareLabel} — edit` ``
- the meta line, after `{categoryLabel}`: `{learned && <LearnedIcon className="ml-1 inline-block h-3 w-3 align-[-1px] text-faint" />}` with the comment `{/* An icon only: a link inside this <button> is invalid HTML. The aria-label above says it. */}`
- `CategoryPicker` in the sheet gets `value={category.name}` and `source={category.source}`.
- directly after the sheet's Category `<label>…</label>` (inside the non-card-payment branch, which becomes a fragment):

```tsx
                  {learned && (
                    <p className="flex items-center gap-1.5 text-xs text-muted" title={learnedText(category.name, t.merchant_name)}>
                      <LearnedIcon className="h-3.5 w-3.5 shrink-0" />
                      <span>
                        Learned from {merchant}.{' '}
                        <Link href="/settings#category-rules" className="font-medium text-emerald hover:text-emerald-600">
                          Manage in Settings
                        </Link>
                      </span>
                    </p>
                  )}
```

`app/(app)/transactions/page.tsx`: import `resolveCategory`; both row components get `category={resolveCategory(t, ctx)}` in place of `categoryName={…}`.

- [ ] **Step 4: Run them.** Same command as Step 2, then `npx vitest run && npx tsc --noEmit && npm run lint`. Expected: PASS.

- [ ] **Step 5: Measure the desktop cell in Chromium.** Start the dev server with the 021 migration applied and the seed run locally (if the owner has not applied 021 yet, skip to Step 6 and say so in the task report). On `/transactions` at 1280px, use the Playwright MCP's `browser_evaluate` on a learned row to read `getBoundingClientRect()` of the select, the marker link and the `<tr>`. Expected: the marker's height equals the select's (34px), their vertical centres match within 1px, the row's height equals an unlearned row's, and the marker's right edge is inside the cell. If the select is not 34px, change `h-[34px]` to its measured height and the comment with it. Then trigger a failed save (block `/api/transactions/categorize` with `browser_network_request` or temporarily rename the route locally) and confirm the marker's top stays aligned with the select's top while the alert shows below.

- [ ] **Step 6: Commit.**

```bash
git add components app/\(app\)/transactions/page.tsx tests
git commit -m "Mark rows a merchant rule relabelled, on desktop and phone (#28)"
```

---

### Task 11: Tripwire 4 (spec §7.4)

**Files:**
- Modify: `scripts/check-invariants.mjs`
- Create: `tests/unit/check-invariants.test.ts`

**Interfaces:**
- Produces: `scripts/check-invariants.mjs` exports `checkCategoryReads(files)`, `checkRulesReads(files)`, `checkUserCategoryWrites(files)`, `checkBrandCasts(files)`, each `({ path: string; text: string }[]) => { check: string; file: string; line: number; message: string }[]`. Running the script directly behaves exactly as before, plus the four new checks.

- [ ] **Step 1: Write the failing tests.** Create `tests/unit/check-invariants.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect } from 'vitest'
import {
  checkCategoryReads,
  checkRulesReads,
  checkUserCategoryWrites,
  checkBrandCasts,
} from '../../scripts/check-invariants.mjs'

// Tripwire 4 (#28 spec §7.4): a page that reads categories or rules on its own, a write of
// user_category outside the two routes allowed it, or a cast that fakes a branded context.
// Fixtures are inline; none lives under app/, lib/ or components/.
const file = (path: string, text: string) => [{ path, text }]
const checks = (r: { check: string }[]) => r.map((f) => f.check)

describe('category-read', () => {
  it('fires on a page reading categories itself', () => {
    expect(checks(checkCategoryReads(file('app/(app)/x/page.tsx', `supabase.from('categories').select('id')`)))).toEqual(['category-read'])
  })
  it('fires on pfcToName outside lib/categories.ts and lib/category-rules.ts', () => {
    expect(checks(checkCategoryReads(file('lib/x.ts', 'const m = pfcToName(cats)')))).toEqual(['category-read'])
  })
  it('allows the helper and the three routes', () => {
    for (const p of ['lib/category-context.ts', 'app/api/categories/route.ts', 'app/api/transactions/categorize/route.ts', 'app/api/category-rules/route.ts']) {
      expect(checkCategoryReads(file(p, `supabase.from('categories').select('id')`))).toEqual([])
    }
    expect(checkCategoryReads(file('lib/category-rules.ts', 'pfcToName(categories)'))).toEqual([])
  })
  it('ignores a mention in a comment', () => {
    expect(checkCategoryReads(file('lib/x.ts', `// never call .from('categories') here`))).toEqual([])
  })
})

describe('rules-read', () => {
  it('fires outside the helper and the two routes', () => {
    expect(checks(checkRulesReads(file('app/(app)/x/page.tsx', `supabase.from('category_rules').select('id')`)))).toEqual(['rules-read'])
  })
  it('allows the helper and the two routes', () => {
    for (const p of ['lib/category-context.ts', 'app/api/transactions/categorize/route.ts', 'app/api/category-rules/route.ts']) {
      expect(checkRulesReads(file(p, `supabase.from('category_rules').select('id')`))).toEqual([])
    }
  })
})

describe('user-category-write', () => {
  it('fires on clearing picks outside the allowed routes', () => {
    expect(checks(checkUserCategoryWrites(file('lib/x.ts', `await supabase.from('transactions').update({ user_category: null }).eq('id', id)`)))).toEqual(['user-category-write'])
  })
  it('fires on a multi-line update whose third key is user_category', () => {
    const src = `await supabase
      .from('transactions')
      .update({
        removed: false,
        reimbursable_note: null,
        user_category: 'Grocery',
      })
      .eq('id', id)`
    expect(checks(checkUserCategoryWrites(file('app/api/x/route.ts', src)))).toEqual(['user-category-write'])
  })
  it('fires on a payload held in a variable, and on a spread', () => {
    expect(checks(checkUserCategoryWrites(file('lib/x.ts', `await supabase.from('transactions').update(patch).eq('id', id)`)))).toEqual(['user-category-write'])
    expect(checks(checkUserCategoryWrites(file('lib/x.ts', `await supabase.from('transactions').update({ ...patch }).eq('id', id)`)))).toEqual(['user-category-write'])
  })
  it('fires in a scripts/ .mjs file', () => {
    expect(checks(checkUserCategoryWrites(file('scripts/fix.mjs', `await db.from('transactions').update({ user_category: 'x' })`)))).toEqual(['user-category-write'])
  })
  it('does not fire on the isCreditCardPayment argument shape, or a select naming the column', () => {
    expect(checkUserCategoryWrites(file('components/X.tsx', `isCreditCardPayment({ pfc_detailed: p, user_category: c })`))).toEqual([])
    expect(checkUserCategoryWrites(file('lib/x.ts', `supabase.from('transactions').select('id, user_category').eq('removed', false)`))).toEqual([])
  })
  it('allows the categorize and categories routes, and variable payloads in ingest and the sandbox seed', () => {
    expect(checkUserCategoryWrites(file('app/api/transactions/categorize/route.ts', `supabase.from('transactions').update({ user_category: picked.name }, { count: 'exact' })`))).toEqual([])
    expect(checkUserCategoryWrites(file('app/api/categories/route.ts', `supabase.from('transactions').update({ user_category: null }).eq('user_category', name)`))).toEqual([])
    expect(checkUserCategoryWrites(file('lib/ingest.ts', `supabase.from('transactions').upsert(upserts, { onConflict: 'plaid_transaction_id' })`))).toEqual([])
    expect(checkUserCategoryWrites(file('scripts/seed-sandbox-bank.mjs', `db.from('transactions').insert(rows)`))).toEqual([])
  })
  it('passes an inline write that does not touch user_category', () => {
    expect(checkUserCategoryWrites(file('app/api/reimbursable/route.ts', `supabase.from('transactions').update({ reimbursable_amount: 5 }, { count: 'exact' })`))).toEqual([])
  })
})

describe('brand-cast', () => {
  it.each(['as CategoryData', 'as unknown as CategoryContext', 'as KindContext', 'as SpendContext'])('fires on `%s` outside the producers', (cast) => {
    expect(checks(checkBrandCasts(file('app/(app)/x/page.tsx', `const c = x ${cast}`)))).toEqual(['brand-cast'])
  })
  it('allows the three producers', () => {
    for (const p of ['lib/category-rules.ts', 'lib/category-context.ts', 'lib/spend-context.ts']) {
      expect(checkBrandCasts(file(p, 'return x as CategoryData'))).toEqual([])
    }
  })
})
```

- [ ] **Step 2: Run them.** `npx vitest run tests/unit/check-invariants.test.ts`. Expected: FAIL, the functions are not exported.

- [ ] **Step 3: Restructure the script.** In `scripts/check-invariants.mjs`:
  1. Add `import { pathToFileURL } from 'node:url'`.
  2. Turn the three existing checks into exported functions over `files` that return failures instead of pushing them: `export function checkUncheckedReads(files)`, `export function checkRuntimeClock(files)`, `export function checkTxnReads(files)`. Each builds and returns its own array of `{ check, file, line, message }`, keeping its comment block and allowlist above it unchanged. `report(...)` becomes a local `out.push({ check, file, line, message })`.
  3. Change `chainAfter` to record each call's closing index: `calls.push({ name: m[1], args: text.slice(open + 1, close), codeArgs: code.slice(open + 1, close), close })`. Existing callers ignore the new fields.
  4. Add `const lineOf = (text, at) => text.slice(0, at).split('\n').length`.
  5. Add tripwire 4 after tripwire 3:

```js
// ---------------------------------------------------------------------------
// 4. Categories and rules are read in one place, and only two routes write user_category.
//
// #28. A category name comes from resolveCategory (lib/category-rules.ts), over a context only
// fetchCategoryContext (lib/category-context.ts) can produce. A page that read categories itself
// and built its own map would compile, ignore every rule, and show Safeway under Food & Drink on
// one page and Grocery on the next. And a rule must never write user_category: any value there on
// a card payment re-enters it into every total, which once took a month's spending from $3,949.16
// to -$3,917.53 (#59).
// ---------------------------------------------------------------------------
const CATEGORY_READS_ALLOWED = new Map([
  ['lib/category-context.ts', 'The one read every page goes through.'],
  ['app/api/categories/route.ts', 'Manages categories.'],
  ['app/api/transactions/categorize/route.ts', 'Validates a pick and builds its KindContext from the whole list.'],
  ['app/api/category-rules/route.ts', 'Validates a Change: the target must count the same way.'],
])
const PFC_TO_NAME_ALLOWED = new Set(['lib/categories.ts', 'lib/category-rules.ts'])
const RULES_READS_ALLOWED = new Map([
  ['lib/category-context.ts', 'The one read every page goes through.'],
  ['app/api/transactions/categorize/route.ts', 'Learns a rule from a first pick (spec §6.1 step 8, PR 3).'],
  ['app/api/category-rules/route.ts', 'Change and Remove.'],
])
const USER_CATEGORY_WRITERS = new Map([
  ['app/api/transactions/categorize/route.ts', 'Sets a pick on one transaction, with guards (spec §6.1).'],
  ['app/api/categories/route.ts', 'Rename and delete cascade a category name onto picks (#100).'],
])
const VARIABLE_PAYLOADS_ALLOWED = new Map([
  ['lib/ingest.ts', 'Its upserts come from transactionUpsertRow, which never carries user_category (tests/unit/ingest-reimbursable.test.ts).'],
  ['scripts/seed-sandbox-bank.mjs', 'Sandbox rows, never a user_category.'],
])
const BRAND_PRODUCERS = new Set(['lib/category-rules.ts', 'lib/category-context.ts', 'lib/spend-context.ts'])

function findAll(re, src) {
  const at = []
  let m
  while ((m = re.exec(src))) at.push(m.index)
  return at
}

export function checkCategoryReads(files) {
  const out = []
  for (const { path, text } of files) {
    const { text: commentFree, code } = views(text)
    if (!CATEGORY_READS_ALLOWED.has(path)) {
      for (const at of findAll(/\.from\(\s*(['"])categories\1\s*\)/g, commentFree)) {
        out.push({ check: 'category-read', file: path, line: lineOf(text, at), message:
          'reads categories directly. Use fetchCategoryContext (lib/category-context.ts), so rules apply (#28).' })
      }
    }
    if (!PFC_TO_NAME_ALLOWED.has(path)) {
      for (const at of findAll(/\bpfcToName\s*\(/g, code)) {
        out.push({ check: 'category-read', file: path, line: lineOf(text, at), message:
          'builds its own Plaid-to-name map, which ignores rules. Resolve through resolveCategory (#28).' })
      }
    }
  }
  return out
}

export function checkRulesReads(files) {
  const out = []
  for (const { path, text } of files) {
    if (RULES_READS_ALLOWED.has(path)) continue
    for (const at of findAll(/\.from\(\s*(['"])category_rules\1\s*\)/g, views(text).text)) {
      out.push({ check: 'rules-read', file: path, line: lineOf(text, at), message:
        'reads category_rules outside lib/category-context.ts and the two routes allowed to (#28).' })
    }
  }
  return out
}

// The first top-level argument of a call, from its blanked source.
function firstArg(codeArgs) {
  let depth = 0
  for (let k = 0; k < codeArgs.length; k++) {
    const c = codeArgs[k]
    if (c === '(' || c === '{' || c === '[') depth++
    else if (c === ')' || c === '}' || c === ']') depth--
    else if (c === ',' && depth === 0) return codeArgs.slice(0, k)
  }
  return codeArgs
}

export function checkUserCategoryWrites(files) {
  const out = []
  for (const { path, text } of files) {
    const { text: commentFree, code } = views(text)
    for (const at of findAll(/\.from\(\s*(['"])transactions\1\s*\)/g, commentFree)) {
      const calls = chainAfter(code, commentFree, at)
      const write = calls.find((c) => /^(update|upsert|insert)$/.test(c.name))
      if (!write) continue
      const line = lineOf(text, at)
      const chain = commentFree.slice(at, calls[calls.length - 1].close + 1)
      if (/\buser_category\b/.test(chain) && !USER_CATEGORY_WRITERS.has(path)) {
        out.push({ check: 'user-category-write', file: path, line, message:
          'writes user_category outside the categorize and categories routes. A rule must never write it, ' +
          'and any value on a card payment re-enters it into every total (#28, #59).' })
        continue
      }
      const payload = firstArg(write.codeArgs).trim()
      if ((!payload.startsWith('{') || payload.includes('...')) && !VARIABLE_PAYLOADS_ALLOWED.has(path)) {
        out.push({ check: 'user-category-write', file: path, line, message:
          'writes transactions with a payload this check cannot read (a variable or a spread), so it cannot ' +
          'tell whether user_category is in it. Write an inline object literal, or allowlist the file with a reason (#28).' })
      }
    }
  }
  return out
}

export function checkBrandCasts(files) {
  const out = []
  for (const { path, text } of files) {
    if (BRAND_PRODUCERS.has(path)) continue
    for (const at of findAll(/\bas\s+(CategoryData|KindContext|CategoryContext|SpendContext)\b/g, views(text).code)) {
      out.push({ check: 'brand-cast', file: path, line: lineOf(text, at), message:
        'casts to a branded category type. Build it through its producer, so the rules cannot be left out (#28).' })
    }
  }
  return out
}
```

  6. Replace the module's top-level `files` construction and the final failure printing with a `main()` that runs only when the script is executed directly:

```js
function walk(dir, out = [], ext = /\.tsx?$/) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry.startsWith('.')) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out, ext)
    else if (ext.test(full)) out.push(full)
  }
  return out
}

function main() {
  const ROOT = process.cwd()
  const read = (f) => ({ path: relative(ROOT, f), text: readFileSync(f, 'utf8') })
  const files = ['app', 'lib', 'components'].flatMap((d) => walk(join(ROOT, d))).map(read)
  let scripts = []
  try {
    scripts = walk(join(ROOT, 'scripts'), [], /\.mjs$/)
      .map(read)
      .filter((f) => f.path !== 'scripts/check-invariants.mjs')
  } catch {
    // No scripts/ directory (the scratch trees in tests/unit/check-invariants-txn-reads.test.ts).
  }
  const failures = [
    ...checkUncheckedReads(files),
    ...checkRuntimeClock(files),
    ...checkTxnReads(files),
    ...checkCategoryReads(files),
    ...checkRulesReads(files),
    ...checkUserCategoryWrites([...files, ...scripts]),
    ...checkBrandCasts(files),
  ]
  if (failures.length) {
    console.error(`\ncheck:invariants — ${failures.length} problem(s):\n`)
    console.error(failures.map((f) => `  ${f.file}:${f.line}\n      [${f.check}] ${f.message}`).join('\n\n'))
    console.error(
      '\nEach of these is a shape that has shipped a real bug here. Fix it, or add the file to the ' +
        'matching allowlist in scripts/check-invariants.mjs with a reason and an issue number.\n'
    )
    process.exit(1)
  }
  console.log('invariants ok')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
```

  Delete the old `ROOT`, `failures`, `files` and `report` top-level definitions.

- [ ] **Step 4: Run them.** `npx vitest run tests/unit/check-invariants.test.ts tests/unit/check-invariants-txn-reads.test.ts && npm run check:invariants`. Expected: PASS, and `invariants ok`. If the real tree fires on a file not named in this plan, **do not allowlist it**: report the file and line in the task report. A genuine `user_category` writer or variable-payload transactions write that this plan does not know about is a finding.

- [ ] **Step 5: Commit.**

```bash
git add scripts/check-invariants.mjs tests/unit/check-invariants.test.ts
git commit -m "Add tripwire 4: one category read, two user_category writers, no faked contexts (#28)"
```

---

### Task 12: Verify, mutation-check, and open PR 2

**Files:** none new. This task is the controller's, run after the final whole-branch review.

- [ ] **Step 1: The full gate.** Run, and paste the summary lines into the PR:

```bash
npx tsc --noEmit && npm run lint && npm run check:invariants && npm run check:secrets \
  && npx vitest run && VITEST_TZ=America/Los_Angeles npx vitest run && npx next build
```

Expected: all clean; the test count is PR 1's 724 plus this PR's.

- [ ] **Step 2: Mutation checks.** For each guard below: make the one-line change, run the named test file, confirm at least one test fails, restore with `git checkout -- <file>`, and record "killed by <test name>" in the PR. A survivor is a missing test: write it, then re-run the mutant.

| # | File | Mutation | Must be killed by |
| --- | --- | --- | --- |
| 1 | `lib/category-rules.ts` | delete the `isCardPaymentRow` early return | `category-rules.test.ts`, `category-money.test.ts` |
| 2 | `lib/category-rules.ts` | drop `kind === bank.kind &&` | "after Transfer Out is deleted…" |
| 3 | `lib/category-rules.ts` | drop `&& kind === kindOf(bank.name, ctx)` | "after Transfer Out is deleted…" (transfer rule) |
| 4 | `lib/category-rules.ts` | `if (rule)` instead of `if (rule && name)` | "rule's category is missing" |
| 5 | `lib/category-rules.ts` | remove the household guard | "throws on rules from more than one household" |
| 6 | `lib/category-rules.ts` | `merchantKey` without `.toLowerCase()` | "matches across case" |
| 7 | `lib/read-all.ts` | `readAllById`: stop on `data.length < PAGE_SIZE` | "does not depend on the server cap" |
| 8 | `lib/read-all.ts` | `readAllById`: `if (!data) return { data: all, … }` | "neither data nor error" |
| 9 | `lib/category-context.ts` | drop the `rules.error` throw | "throws, naming the migration" |
| 10 | `lib/category-views.ts` | `filterByCategory` without the `isCreditCardPayment` skip | "leaves the unpicked card payment out" |
| 11 | `lib/category-views.ts` | `categoryUsage` without the skip | "counts each category's rows exactly as its drill-down" |
| 12 | `lib/category-views.ts` | `deleteImpact` without clearing the deleted pick | "never counts a pick … as staying" |
| 13 | `lib/category-views.ts` | `filterByFlow` without `amt === 0` | "splits as monthlyFlows does" |
| 14 | `app/api/category-rules/route.ts` | drop the env guard call | "%s guards … environment" |
| 15 | same | drop `.eq('category_id', expectedCategoryId)` from the update | "moves a rule … guarded" |
| 16 | same | drop it from the delete | "deletes guarded on the category it expected" |
| 17 | same | drop the kind comparison | "refuses a cross-kind Change" |
| 18 | same | `if (!count)` → `if (count === 0)` with `count: null` stub | "409 on a zero count…" (add a `count: null` case if it survives) |
| 19 | same | drop the `23503` branch | "409 … on 23503" |
| 20 | same | drop the `rule.category_id !== expectedCategoryId` check | "409 for a stale expected category" |
| 21 | same | drop the 403 | "403 without a household" |
| 22 | `app/api/categories/route.ts` | drop the env guard | `categories-route.test.ts` |
| 23 | `app/(app)/settings/page.tsx` | drop the `budgetsError` throw | "keeps Banks usable … budgets" |
| 24 | `app/(app)/settings/page.tsx` | remove the `try`/`catch` | "keeps Banks usable … categories" |
| 25 | `components/CategoryPicker.tsx` | key on `value` only | "clears its alert when the source changes" |
| 26 | `components/TransactionRow.tsx` | `category.source === 'rule'` instead of `changedByRule` | "appears only when a rule changed the name" |
| 27 | `lib/save-response.ts` | drop `res.redirected` | "reads a redirect … as an ended session" |
| 28–31 | `scripts/check-invariants.mjs` | empty each of the four new check functions' loops in turn | each check's "fires" cases |

- [ ] **Step 3: Device check is the owner's.** The owner checks on the phone before merge. Prepare the PR's checklist from spec §10.2 steps 2–4 and this list:
  1. With 021 applied and the seed run on a Preview: Safeway rows show Grocery with the learned marker on desktop and on the phone (row icon, sheet line and link).
  2. The marker's link opens Settings at Category rules.
  3. Settings → Category rules lists the rules with counts; the list fits the phone.
  4. Change and Remove answer "This app is pointed at a database from a different environment. Nothing saved." on a Preview (by design: they are first exercised on production).
  5. Deleting a category shows where its transactions go (Cancel; on a Preview it would also refuse).

- [ ] **Step 4: Open the PR.** Push the branch and open PR 2 against `main`, titled `Category learning, PR 2: rules on read, and Settings → Category rules (#28)`, with: Why; what changed by area; the five Rulings and the two smaller departures, each for the owner to accept or reject; intentional behaviour changes (the category drill-down and Settings counts now leave out unpicked card payments; the delete dialog's copy; Settings no longer throws on a categories failure; category delete is environment-guarded); verification (Step 1's output, the mutation table, the Chromium measurements from Task 10 Step 5); the device checklist; issues filed along the way. End with the attribution lines. **Do not merge.**

---

## Self-review notes

- **Spec coverage.** §4 → Task 1. §5.1–5.3 → Task 3. §5.3's `effectiveCategory` → Task 5. §5.4 → Task 5's property tests. §6.2 → Task 8. §6.3 → Task 8. §7.1 → Task 4 (with Ruling 3 replacing `readAllByKeyset`). §7.2 → Tasks 6 and 7. §7.3 → Tasks 5–7, 9. §7.4 layers 1–3 → Tasks 3–5; tripwire 4 → Task 11; layer 5 → page tests in Tasks 5–7, 9, 10. §8.1 → Task 10 (with Rulings 1, 2, 5). §8.2's source key → Task 10. §8.3 → Task 9. §8.4 → Task 7. §9 → Task 1. §10.1's README → Task 1. §11's PR 2 items → the task that owns each. §6.1 step 8 and its tests are PR 3; §14 is PR 4.
- **Types across tasks.** `CategoryData`, `CategoryContext`, `KindContext`, `ResolvedCategory`, `CategorizableTxn`, `CategoryRule`, `Kind` (Task 3); `CountTxn` (Task 4); `SpendContext` (Task 5); `RuleCounts`, `DeleteImpact` (Task 7); `RuleView`, `RuleCategory` (Task 7, moved to the card in Task 9); `CategoryUsage` with `impact` (Task 7). `categoryUsage` takes `CategoryData` (stated in Rulings).
- **Known risk.** Removing the page casts depends on postgrest-js inferring row types from the select string (spec §7.4 layer 2). Task 4's `@ts-expect-error` probe proves it early; Task 6 says what to do if a page's inference falls short (annotate, never cast).
