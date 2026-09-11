# Learning From Recategorization — Design Spec

- **Repo:** `smilne3/every-dollar-counts`
- **Date:** 2026-09-11
- **Closes:** #28
- **Status:** Design approved in brainstorming (sections 1–3). Revised after an adversarial review of this document. Awaiting owner review.
- **One line:** The first time you file a merchant under a category, the app remembers it as a household rule and applies it to that merchant's other transactions, past and future. Rules are resolved whenever a page reads, never written onto a transaction, so changing or removing one moves every row with it.

---

## 1. Why this exists

Recategorizing writes `user_category` on one row and nothing else (`app/api/transactions/categorize/route.ts:18-21`). Filing a Safeway purchase under Grocery teaches the app nothing about the next one.

On live data (read-only probe, 2026-09-10):

| | |
| --- | --- |
| Transactions (not removed) | 1,238 |
| Hand picks (`user_category` set) | 49 |
| Merchants with 5+ transactions | 36, holding 622 rows (50%) |
| Safeway | 159 rows: 14 picked Grocery by hand, **145 still Food & Drink** |
| Merchants picked 2+ times whose picks conflict | **0**. A rule learned from the other picks predicts each one: 28/28 |

The repetition is most of the table, and the household is consistent about it. All 14 Safeway picks sit on rows Plaid tagged with VERY_HIGH confidence. Plaid isn't wrong here; the household wants a finer category of its own.

**The hazard that shapes everything.** `user_category` is not just a label. `isCreditCardPayment(t)` is `!t.user_category && t.pfc_detailed === 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT'` (`lib/categories.ts:49-54`), and seven sites gate on it: both aggregators, the dashboard's Recent activity, the transactions flow filter, the reimbursable route, `TransactionRow` and `ReimbursableCheckbox`. Any value in `user_category` on a card payment re-enters both legs into every total. Measured on a real $7,866.69 autopay, that took a month's spending from $3,949.16 to −$3,917.53 (#59). A learned rule that wrote `user_category` would walk straight into it.

**Success looks like:**
- picking a category for a merchant once is enough, for its history and its future;
- totals never move because of a rule;
- every learned label is visible, changeable and removable in one place.

## 2. Decisions

Settled with the owner during brainstorming. They are not open during implementation.

1. **Learn silently.** A hand pick teaches the app. No prompt.
2. **Past and future, reversibly.** A rule applies to every matching transaction, history included. Changing or removing it relabels or restores every row it labelled. Hand picks live only in `user_category`, and **a rule never writes that column.**
3. **First pick creates the rule; later picks are exceptions.** The first hand pick for a merchant with no rule creates one. After that, a pick on any of that merchant's rows changes only that row. Rules change only in **Settings → Category rules**, which offers **Change** (same kind only) and **Remove**. The one exception is deleting a category, which deletes its rules too (§4, §8.4).
4. **Never across the line.** A rule relabels a row only when the rule's category counts the same way as that row's bank category (spending, transfer or income). A pick that crosses the line changes only its own row and creates no rule.
5. **Seed at launch** from the household's existing hand picks.
6. **Remove forgets.** Removing a rule deletes it. Its rows go back to the bank's category, and the next pick for that merchant teaches again. This was chosen over "stop learning this merchant", accepting that a merchant fitting no single category re-learns on its next correction.
7. **No "Automatic" option.** A hand pick stays until someone picks a different category. Accepted costs: a hand pick can't rejoin its merchant's rule, and a card payment that already carries a category keeps counting. There are none today.

Defaults accepted along with them:
- **Match** on exact `merchant_name`, ignoring case and surrounding whitespace. `Walmart` and `Walmart+` stay two merchants.
- **No `merchant_name`, no rule.** That leaves out all 247 merchant-less rows, including every card payment (23), every Venmo row (24) and person-to-person transfers.
- **Card payments are exempt inside the category logic itself**, not only in the UI.
- **Visible:** a "learned" marker wherever a category is shown with a picker, and every rule listed in Settings with its count.
- **Not in Settings:** creating a rule from scratch, editing the merchant a rule matches, pausing a rule.

### 2.1 Choices this spec adds

These follow from the decisions but were not individually approved. Flag any of them in review.

- **A pick that equals the row's bank category teaches nothing, and doesn't seed.** It would only pin the merchant to a rule that changes no row (§6.1 step 8, §9).
- **The seed reads only non-removed rows and runs once** (§9).
- **The rule gate checks two kinds, not one** (§5.2). When a default Income or Transfer category has been deleted, the totals count that category's rows as spending while Plaid still tags them as income or transfers. A rule applies only when both agree, so no set of rules can move money.
- **Deleting a category deletes its rules, and the delete becomes environment-guarded** (§6.3), so a local or Preview session can't delete production rules.
- **Card payments without a pick are left out of the Settings category counts and the delete dialog** (§7.2), matching the totals and the drill-downs.
- **Settings stays usable when rules fail to load** (§7.3), so a broken bank can still be reconnected.

## 3. The model

```
categories ──────┐
                 ├─► fetchCategoryContext() ─► CategoryData ─► buildCategoryContext() ─► CategoryContext
category_rules ──┘   (throws on a failed read)   (branded)                                (branded)
                                                                                              │
transactions (a row) ─────────────────────────────────────────────► resolveCategory(row, ctx) ◄┘
                                                        { name, source, ruleId, bankName } ─► every page
```

Three rules hold the design together:

1. **A rule's effect exists only at read time.** Nothing is stored on `transactions`. Change and Remove have nothing to clean up, and a rollback is a code revert. Ingest (`lib/ingest.ts`) is not touched.
2. **One function decides a category.** `resolveCategory` is the only code that turns a row into a category name. Precedence, the card-payment exemption and the kind gate all live there, built on helpers the routes share (§5.2). Every page, count and filter goes through it; the seed restates the kind gate in SQL once, at launch (§9).
3. **A page that forgets the rules does not compile.** The context that carries rules can only be built from what `fetchCategoryContext()` returns, rows must select the columns the resolver needs, and the casts that would hide a missing column are removed.

### 3.1 Why read-time, not a stored column

Three architectures were designed and scored by independent judges on two lenses (money safety, and fidelity plus deliverability), then red-teamed:

| Approach | Score | Why not |
| --- | --- | --- |
| **A. Resolve rules on read** | **16/20**, no blockers | Chosen |
| B. Store the result in a new column on `transactions` | 14/20 | Pays both costs. Every page still changes, *and* ingest gains a step that can throw inside `syncAndStore` and mark a bank falsely `temporarily_unavailable` (`app/api/plaid/sync-transactions/route.ts:82-103`). It also brings the repo's first RPCs and advisory locks, plus more plpgsql (today the only plpgsql is the household-creation trigger, `007_categories.sql:45-52`). |
| C. Write into `user_category` with a provenance column | 7/20 | Breaks decision 2 by construction, and puts about nine triggers on the ingest path. |

A's real cost: a row's effective category has no SQL form, so complete counts need a paged read of every transaction (§7.1). At 1,238 rows that is three requests: 1,000 rows, 238, then an empty page.

## 4. Storage: `db/migrations/020_category_rules.sql`

Hand-run in the SQL editor, re-runnable, and appended to the README run order (`README.md:75`). **It creates no rows.** Seeding is a separate script (§9).

```sql
-- 1) FK target: (household_id, id) on categories. id is already the PK (007:6), so this cannot fail.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'categories_household_id_id_key') then
    alter table public.categories
      add constraint categories_household_id_id_key unique (household_id, id);
  end if;
end $$;

-- 2) Table and its security in ONE statement, so the table never exists without RLS.
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

-- 3) Idempotent re-asserts for a re-run (007 pattern).
alter table public.category_rules enable row level security;
drop policy if exists "manage your category rules" on public.category_rules;
create policy "manage your category rules" on public.category_rules
  for all to authenticated
  using ( household_id in (select private.household_ids()) )
  with check ( household_id in (select private.household_ids()) );

-- 4) Explicit grants. No anon grant.
grant select, insert, update, delete on table public.category_rules to authenticated;
grant select, insert, update, delete on table public.category_rules to service_role;
```

**Why explicit grants.** No migration in this repo grants table privileges; the only `grant` is on `private.household_ids()` (`001_households_memberships.sql:28`). Every table so far has relied on Supabase granting new public tables to its API roles automatically. Supabase has announced it is ending that default (its changelog, found during the spec review). Without a grant the app gets `42501 permission denied` even though RLS and the policy look correct, while the seed, run as `postgres`, still succeeds. A grant is idempotent and harmless under RLS.

**The unique `(household_id, merchant_key)`** does three jobs. It is the lookup key, it stops two simultaneous first picks from creating two rules, and it is why each merchant has exactly one rule.

**The category is referenced by id, not by name.** This breaks the convention in `007_categories.sql:1-3`, for five reasons:

1. **Renames need no cascade.** The existing name cascades are four separate requests, unchecked and not atomic (`app/api/categories/route.ts:65-68, 86-88`). A rule left pointing at a stale name would count as spending everywhere (`lib/categories.ts:71-84`).
2. **Deleting a category deletes its rules in the same statement**, through `on delete cascade`. This is the one way a rule changes outside Settings → Category rules. The delete dialog says so (§8.4), and the delete is environment-guarded (§6.3).
3. **A re-added category can't inherit a rule.** It gets a new id and a null `pfc_primary` (`route.ts:45`), so a rule that once pointed at Income can never re-attach to a spending category of the same name.
4. **The composite FK blocks pointers into another household.** Postgres runs foreign-key checks outside RLS, so a plain `category_id` FK would accept another household's category id.
5. **A category's kind can't change through the app.** PATCH only renames (`route.ts:65`) and POST inserts a null `pfc_primary`, so "Change: same kind only" holds for a rule's whole life.

**No FK to `transactions`, `accounts` or `plaid_items`.** Disconnecting a bank cascade-deletes those rows (`010_plaid_production.sql:45-52`), and rules must survive a relink. Precedent: `018_plaid_slot_ledger.sql`.

**Never drop or empty `category_rules` while any deployment built from PR 2 or later, production or Preview, is live.** One database serves local, Preview and production (`017_app_env.sql:3-7`), and five money pages and Settings read this table on every load.

## 5. Resolving a category: `lib/category-rules.ts`

Pure, no I/O.

### 5.1 Types

```ts
export type CategorizableTxn = {           // all four REQUIRED: a select that omits one fails tsc
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

// Branded. Fields are readable. Produced only by fetchCategoryContext (§7.1).
export type CategoryData = { readonly categories: Category[]; readonly rules: CategoryRule[] } & DataBrand

// Branded. buildKindContext(categories): kinds and bank categories, no rules.
export type KindContext

// Branded. buildCategoryContext(data, opts?): everything a KindContext holds, plus the rules.
export type CategoryContext

export type ResolvedCategory = {
  name: string
  source: 'pick' | 'rule' | 'bank'
  ruleId: string | null
  bankName: string                        // what the bank mapping alone would show
}
```

- **Branding.** `CategoryData`, `KindContext` and `CategoryContext` each carry a `unique symbol` brand, so a hand-built literal such as `{ categories, rules: [] }` does not type-check. The brands are cast only inside their producers and in a test helper in `tests/unit/helpers/`. A deliberate type assertion still compiles; §7.4 covers that.
- **Contexts.** A `CategoryContext` is accepted wherever a `KindContext` is. Neither exposes its maps or name sets. Their private state lives in the context's own properties (a non-exported symbol key, or closures), never in a `WeakMap` or `#private` fields, so `buildSpendContext` can spread one.
- **Without a category.** `buildCategoryContext(data, { withoutCategoryId })` builds the context as if that category, and every rule pointing at it, were already gone. `deleteImpact` uses it (§7.2), so no other code needs to construct a `CategoryData`.
- **Household guard.** `buildCategoryContext` throws `category rules span more than one household` when the rules carry more than one `household_id`. The read side already assumes one household per user (`lib/spend-context.ts:24`); this makes the assumption fail loudly for rules instead of silently.

### 5.2 Helpers

- **`merchantKey(s)`**: `null` for `null`, `''` or whitespace; otherwise trimmed and lowercased.
- **`kindOf(name, k: KindContext)`**: `'transfer'` if the name is in the transfer names, else `'income'` if it is in the non-spending names, else `'spending'`.
  - These are **the exact sets the totals branch on** (`lib/dashboard.ts:106-121`, `lib/budget.ts:25-31`). `'Uncategorized'`, and any name no category holds, is in neither, so it counts as spending.
  - Transfers are tested first because the non-spending set contains them (`lib/categories.ts:33,37`).
- **`bankCategory(t, k: KindContext) → { name, kind }`**:
  - `name` is `pfcMap[t.pfc_primary] || 'Uncategorized'`, the same last-wins mapping `pfcToName` builds today (`lib/categories.ts:57-61`).
  - `kind` is `kindOf(name)` when the primary maps to a household category. **When it doesn't** (its default category was deleted, or Plaid sent a primary with no default, such as `LOAN_DISBURSEMENTS`), `kind` comes from Plaid's own tag: `TRANSFER_IN`/`TRANSFER_OUT` is a transfer, `INCOME` is income, anything else is spending.
- **Why the gate checks both kinds.** For a mapped row, `bankCategory(t).kind === kindOf(bankCategory(t).name)`. For an unmapped row the two can differ: the totals count the row by the name it shows (`Uncategorized`, so spending) while Plaid calls it a transfer or income. A rule therefore applies only when its kind matches **both** (§5.3 step 4). Checking Plaid's kind stops a spending rule from capturing a transfer after "Transfer Out" is deleted. Checking the shown name's kind stops a transfer rule from pulling that same row out of Spent. Either way the row takes no rule and stays `Uncategorized`, counted exactly as it is today.
- **`lib/categories.ts`** exports `CREDIT_CARD_PAYMENT_DETAILED` (private today, `:45`) and `isCardPaymentRow(pfc_detailed)`. `isCreditCardPayment` is unchanged.

### 5.3 `resolveCategory(t, ctx)`: exact order

1. **Bank category.** `bank = bankCategory(t, ctx)`.
2. **A hand pick wins.** If `t.user_category` is set, return `{ name: t.user_category, source: 'pick', ruleId: null, bankName: bank.name }`. This holds even on a card payment, which keeps the tested contract (`tests/unit/dashboard.test.ts:198-212`).
3. **Card payments never take a rule.** If `isCardPaymentRow(t.pfc_detailed)`, return the bank category. The test uses `pfc_detailed` **alone**, never `isCreditCardPayment`.
4. **Rule.** `key = merchantKey(t.merchant_name)`. Return `{ name: ruleCategory, source: 'rule', ruleId, bankName: bank.name }` when all four hold:
   - a rule exists for the key;
   - its category is still in the context;
   - `kindOf(ruleCategory) === bank.kind`;
   - `kindOf(ruleCategory) === kindOf(bank.name)`.
5. **Otherwise** return `{ name: bank.name, source: 'bank', ruleId: null, bankName: bank.name }`.

**`changedByRule(r)`** is `r.source === 'rule' && r.name !== r.bankName`. It drives the marker and the Settings counts.

**The amount's sign is not tested.** A Safeway refund becomes a Grocery refund and nets Grocery down, as refunds already do (`lib/dashboard.ts:116-120`).

**`effectiveCategory(t, ctx)`** (`lib/effective-category.ts`) becomes `resolveCategory(t, ctx).name`. Its second parameter changes from a bare PFC map to `CategoryContext`, so all seven existing call sites fail to compile until they are rewired.

### 5.4 Why the headline totals cannot move

- **Spending.** Relabelling a row within spending leaves the signed sum unchanged.
- **Transfers.** Both totals skip them.
- **Income.** An outflow counts nowhere and an inflow counts as income, whichever income category holds it.
- **Rules stay within one kind.** A rule's kind must equal both Plaid's kind for the row and the kind of the name the totals would otherwise count it under (step 4). Card payments without a pick never take a rule (step 3).

So **no set of rules changes Spent, Income or Saved**, for any set of categories, including one with a default Income or Transfer category deleted. Rules change only which category a dollar sits in. That is both a property test (§11) and a launch check (§10.2).

## 6. Writes

### 6.1 `POST /api/transactions/categorize`

Rewritten using the read-then-guard shape of `app/api/reimbursable/route.ts:26-51` and the count check in `app/api/household/timezone/route.ts:26-42`.

1. **Validate before touching the database.**
   - Parse JSON without throwing.
   - `transactionId` must be a non-empty string, and `category` a non-empty trimmed string; otherwise `400`.
   - Clearing a pick is not supported; no UI has ever sent it (decision 7).
2. **Sign-in:** `401` without a user.
   - In practice `proxy.ts` redirects a signed-out `/api` request to `/login` before the handler runs (`proxy.ts:39-51, 56-58`). The client therefore treats a redirected response as a failure (§8.2).
   - The handler's own `401` stays as defence.
3. **Read the row:** `id, household_id, merchant_name, pfc_primary, pfc_detailed, removed, user_category`.
   - Read error: log, `500`.
   - Missing: `404`.
   - Removed: `400`.
4. **Card payments.** `isCardPaymentRow(pfc_detailed)` answers `400`: "A credit-card payment is already kept out of spending and income." The test is on `pfc_detailed` alone, so a card payment that already carries a pick can't pass either.
5. **Read all of the row household's categories:** `select('id, name, pfc_primary, sort_order').eq('household_id', row.household_id).order('sort_order')`.
   - Read error: log `[categorize] categories read failed`, `500` "That could not be saved. Please try again."
   - `picked` is the category whose name equals the trimmed `category`. No match: `400` "That category no longer exists. Refresh and try again."
6. **Write with the guards inside the UPDATE**, so ingest re-tagging the row between the read and the write can't slip through:
   ```ts
   .update({ user_category: picked.name }, { count: 'exact' })
   .eq('id', id)
   .eq('removed', false)
   .or('pfc_detailed.is.null,pfc_detailed.neq.LOAN_PAYMENTS_CREDIT_CARD_PAYMENT')
   ```
   - The `.or` is deliberate: `.neq` alone silently excludes rows whose `pfc_detailed` is null.
   - Error: log, `500` with a written message, never the database's words.
   - A falsy `count`: `409` "This transaction just changed. Refresh and try again."
7. **Log the change** as `[categorize] changed`, with the row id, the previous `user_category` (from step 3) and the new category, so a mistaken pick can be recovered from the logs.
8. **Learn (PR 3).** Let `k = buildKindContext(<the step-5 list>)` and `bank = bankCategory(row, k)`. Never build `k` from a partial list. Learn only when all of these hold:
   - `merchantKey(row.merchant_name)` is not null;
   - `kindOf(picked.name, k) === bank.kind` and `kindOf(picked.name, k) === kindOf(bank.name, k)` (decision 4, §5.2);
   - `picked.name !== bank.name`, because a pick that agrees with the bank teaches nothing and would pin the merchant to a rule that changes nothing.

   Then:
   - **Environment.** Call `assertEnvMatchesDatabase()`.
     - An `EnvMismatchError` is logged as `[categorize] learn skipped: environment` and gives `learned: 'skipped'`.
     - Any other error from the guard, such as an unreadable `app_env` (`lib/app-env.ts:37-40`), is logged as `[categorize] learn failed` and gives `'failed'`.
     - Both are caught, and **the pick stays saved.** Local and Preview run sandbox against the shared database, and must not create rules that production then applies.
   - **Insert if absent:**
     ```ts
     supabase.from('category_rules')
       .upsert(
         { household_id: row.household_id, merchant_key, merchant_label, category_id: picked.id, origin: 'learned' },
         { onConflict: 'household_id,merchant_key', ignoreDuplicates: true },
       )
       .select('id')
     ```
     `merchant_key` is `merchantKey(row.merchant_name)` and `merchant_label` is the row's `merchant_name`, trimmed. This sends `INSERT … ON CONFLICT DO NOTHING RETURNING`, so a row comes back only when one was inserted:
     - one row means `created`;
     - no rows means `exists`, and the pick stays a one-row exception (decision 3);
     - two partners making the same first pick get exactly one rule.
   - **Failure.** Any error, including a category deleted mid-request (`23503`), is logged as `[categorize] learn failed`. **A failed learn never fails the pick.**
9. **Response.**
   - PR 1 and PR 2 answer `200 { ok: true }`, as the route does today.
   - PR 3 adds `learned: 'created' | 'exists' | 'no' | 'skipped' | 'failed'`. The field is for tests and logs; the UI shows nothing (decision 1).

### 6.2 `app/api/category-rules/route.ts` (new, PR 2)

**Every method:**
- parses without throwing and validates strings;
- answers `401` without a user;
- resolves the household from `memberships` (`403` if none);
- runs `assertEnvMatchesDatabase` through `envGuardResponse` (`lib/app-env.ts:66-76`), with tag `[category-rules]`;
- checks every read and uses `{ count: 'exact' }` on every write;
- logs errors and returns written messages.

**The client always sends the category id it was showing**, so an action applies only to the rule the person saw.

- **`PATCH { id, categoryId, expectedCategoryId }`: Change.**
  1. Read the rule. Error: log, `500`. Missing: `404`. `rule.category_id !== expectedCategoryId`: `409` "This rule just changed. Refresh and try again."
  2. Read the household's categories. Error: log, `500`.
  3. `current` is the category with id `expectedCategoryId`. Missing (deleted between reads): `409`, same text.
  4. The target (`categoryId`) must exist, else `400`. The kinds of target and current must match, else `400` "A rule can only move to a category that counts the same way."
  5. `categoryId === expectedCategoryId`: `200`, no write.
  6. Otherwise:
     ```ts
     .update({ category_id: categoryId, updated_at: new Date().toISOString() }, { count: 'exact' })
     .eq('id', id)
     .eq('category_id', expectedCategoryId)
     ```
     The table has no update trigger (precedent: `app/api/manual-assets/route.ts:43`). `error?.code === '23503'` or a falsy `count` gives `409`. Any other error: log, `500`.
- **`DELETE { id, expectedCategoryId }`: Remove (forget).** `delete({ count: 'exact' }).eq('id', id).eq('category_id', expectedCategoryId)`. A falsy count gives `409`. An error: log, `500`.
- **No `POST`**, because creating a rule from scratch is out of scope.

### 6.3 Category routes

`app/api/categories/route.ts` does no rule work. Renames follow the id, and deleting a category removes its rules through the FK.

**DELETE becomes environment-guarded (PR 2).** It calls `assertEnvMatchesDatabase` through `envGuardResponse` (tag `[categories]`) before its first write. Its cascade now deletes production rules, and it already nulls hand picks and deletes budgets in the shared database. POST and PATCH stay unguarded, because neither touches a rule.

The existing unchecked name cascades are no worse than today; hardening them is out of scope.

## 7. Pages

### 7.1 `lib/category-context.ts` (server-only)

- **`fetchCategoryContext = cache(async () => …)`**, the `lib/household.ts:13` pattern. It returns `CategoryData` and makes two reads:
  - **categories:** one read, ordered by `sort_order`;
  - **category_rules:** read through `readAllByKeyset`. The caller's chain is `supabase.from('category_rules').select('id, household_id, merchant_key, merchant_label, category_id, origin').order('id')`.

  It **throws** if either read fails:
  - `could not read categories: …`
  - `could not read category rules: <code> <message> (has db/migrations/020, including its grants, been applied?)`

  A failed rules read can never render as "no rules", which would silently revert every learned label (#46).
- **`readAllByKeyset<T extends { id: string }>(buildPage: () => PostgrestFilterBuilder<any, any, any, T[], any, any, any>): Promise<T[]>`**:
  - The caller's `buildPage` chain carries `.order('id')` literally, so tripwire 3 (`scripts/check-invariants.mjs:95-142`) can see the bound.
  - The helper appends only `.gt('id', lastId)` (from the second page on) and `.limit(1000)`.
  - It checks `error` on every page and **stops only on an empty page**, so a server max-rows below 1,000 can't truncate it.
  - A scratch tsc probe confirmed the generic keeps the inferred row type.
- **`readTransactionsForCounts()`**: `supabase.from('transactions').select('id, merchant_name, user_category, pfc_primary, pfc_detailed').eq('removed', false).order('id')` through the keyset reader. Its return type is written out as `Promise<(CategorizableTxn & { id: string })[]>`, so a select that drops a column fails tsc (TS2322).

### 7.2 Page filters move into `lib/category-views.ts`

Four pieces of category logic sit inline in pages today, where no test can reach them. They become pure functions, and the pages call only these:

| Function | Replaces | Note |
| --- | --- | --- |
| `filterByCategory(rows, name, ctx)` | `transactions/page.tsx:113-115` | **Now skips `isCreditCardPayment` rows**, matching `spendByCategory` (`lib/budget.ts:25`), so a Breakdown row and the list it opens add up. Card payments still appear in the unfiltered list. The transactions page still filters in memory over the newest 200 rows of the month (`:80-81, 95`), so the list adds up only in months with at most 200 non-removed rows. That cap predates #28 (`README.md:107`), which doesn't change it. |
| `filterByFlow(rows, flow, ctx)` | `transactions/page.tsx:116-131` | Branches on `kindOf`. |
| `activityItem(t, ctx)` | `dashboard/page.tsx:168-178` | |
| `categoryUsage(rows, ctx, budgetNames)` | `settings/page.tsx:48-55` | **Skips `isCreditCardPayment` rows**, like `filterByCategory`, so a category's count equals the list its drill-down opens. Today's loop counts card payments under Loan Payments; dropping them is deliberate, because they display as "Card payment" and count in no total. Returns `{ [name]: { txns, hasBudget } }` and, per rule id, `{ changed, pickedByHand }` as §8.3 defines them. |
| `deleteImpact(rows, data, categoryId)` | New | See below. |

**`deleteImpact(rows, data, categoryId)`** runs in `settings/page.tsx`, once per category, over the `readTransactionsForCounts` rows.
- It evaluates **every** non-removed row where `isCreditCardPayment` is false, not only rows that currently show the category:
  - `before = resolveCategory(t, ctx)`;
  - `after = resolveCategory({ ...t, user_category: t.user_category === deleted.name ? null : t.user_category }, buildCategoryContext(data, { withoutCategoryId }))`. This mirrors the DELETE route, which removes the category and then nulls picks with its name (`app/api/categories/route.ts:86-88`).
- A row counts when `before.name !== after.name`, and its destination is `after.name`.
- It returns:
  - `uncategorized`;
  - `moved`, the top three destinations by count;
  - `movedMore`, the rows beyond those three;
  - `rulesRemoved`;
  - `toSpending`, the rows whose kind changes to spending.

### 7.3 The six surfaces

| Surface | Change |
| --- | --- |
| `app/(app)/dashboard/page.tsx` | `fetchCategoryContext()` replaces the categories read and the private map (`:111`). The flows select (`:118`) adds `merchant_name`. The casts at `:132-135` go. Recent activity uses `activityItem`. |
| `app/(app)/transactions/page.tsx` | Replaces the private map (`:54`) and the `RealRow` casts (`:108, 110`). Filters come from §7.2. Each row receives `category={resolveCategory(t, ctx)}`. The select (`:89`) already has both columns. |
| `app/(app)/budgets/page.tsx` | Context from the helper. The select (`:38`) adds `merchant_name`. The casts at `:52-53` go. |
| `app/(app)/trends/page.tsx` | Context from the helper. The select (`:42`) adds `merchant_name`. The cast at `:51` goes. |
| `app/(app)/breakdown/[metric]/page.tsx` | Spent/saved branch only: context, select (`:143`), casts at `:150-151, 167`. Net-worth and cash branches unchanged. |
| `app/(app)/settings/page.tsx` | Replaces the private map (`:42`) and the unbounded, unchecked `Promise.all` (`:43-46`, measured at **1,000 of 1,238 rows**) with the helper, `readTransactionsForCounts` and a checked budgets read. This closes #69's Settings case and #91's two reads at `:43-46`. |

**Aggregators.** `spendByCategory` (`lib/budget.ts:25-31`), `monthlyFlows` (`lib/dashboard.ts:106-121`) and `filterByFlow` replace `effectiveCategory(t, ctx.pfcMap)` and the `ctx.nonSpending`/`ctx.transfers` checks with `resolveCategory(t, ctx).name` and `kindOf(name, ctx)`. A transfer row is skipped, and `'income'` replaces `nonSpending.has`.

- **`lib/spend-context.ts`:** `SpendContext = CategoryContext & { reimbursedByTxn }`, built by `buildSpendContext({ data, txns })`.
- **Row types:** `Txn` and `FlowTxn` (`lib/budget.ts:6-14`, `lib/dashboard.ts:8-15`) gain `merchant_name`.

**Verified untouched:**
- `lib/receivable.ts`, `app/(app)/reimbursements/page.tsx`, `app/api/reimbursable/route.ts` and `components/ReimbursableCheckbox.tsx`. They have no category logic, and `isCreditCardPayment` stays correct because rules never write `user_category`.
- `lib/ingest.ts`, `lib/sync.ts` and `scripts/seed-sandbox-bank.mjs`.

**Settings stays usable when rules fail to load.** Settings is the only place a bank can be reconnected (`components/BankList.tsx`).
- On Settings only, a failure of `fetchCategoryContext`, `readTransactionsForCounts` or the budgets read is caught.
- The Categories and Category rules cards show an inline `role="alert"`, "Couldn't load categories and rules. Try again.", with their actions disabled.
- Household, Banks and Home value render normally.
- No number is shown, so this still honours #46. The money pages keep throwing into `app/(app)/error.tsx`.

### 7.4 Coverage guard

Five layers, compile time first:

1. **Branded contexts** (§5.1). The five bare-map call sites (`settings:53`, `dashboard:171`, `transactions:114,119,250`) and any future one fail tsc, and so does `{ categories, rules: [] }`.
2. **Required columns, casts removed.** Checked with a scratch tsc probe against the installed postgrest-js 2.112.4: an uncast select missing `merchant_name` fails with TS2345, while the same rows cast `as Txn[]` compile. CI type-checks tests too (`.github/workflows/ci.yml:41-42`).
3. **One fetch helper** that throws.
4. **Tripwire 4** in `scripts/check-invariants.mjs`, in the file's shipped-defect style (`:2-11`). Four sub-checks:
   - **category-read.**
     - `pfcToName(` is allowed only in `lib/categories.ts` and `lib/category-rules.ts`.
     - `.from('categories')` is an error anywhere under `app/`, `components/` and `lib/`, except in `lib/category-context.ts` and three routes, each allowlisted by name with a reason:
       - `app/api/categories/route.ts`, which manages categories;
       - `app/api/transactions/categorize/route.ts`, which validates the pick and builds a `KindContext`;
       - `app/api/category-rules/route.ts`, which validates Change.
   - **rules-read.** `.from('category_rules')` appears only in `lib/category-context.ts` and the categorize and category-rules routes.
   - **user-category-write.**
     - **Scope.** `.ts`/`.tsx` files under `app/`, `lib/` and `components/`, and `.mjs` files under `scripts/`, skipping `scripts/check-invariants.mjs` itself. The walker (`:18-30`) gains `.mjs` and the `scripts` root for this check.
     - **What it scans.** Every `.from('transactions')` chain that calls `.update(`, `.upsert(` or `.insert(`, read paren-balanced to the end of its statement.
     - **It fails when:**
       - (a) the chain's text contains `user_category`, except in the categorize and categories routes;
       - (b) the write's first argument is not an inline object literal, or contains a spread, except in files allowlisted by name with a reason: `lib/ingest.ts` (its `upserts` come from `transactionUpsertRow`, which never carries `user_category`, pinned by `tests/unit/ingest-reimbursable.test.ts`) and `scripts/seed-sandbox-bank.mjs` (sandbox rows, no `user_category`).
     - **Out of scope** is a `user_category` key outside a transactions write: type declarations, the `isCreditCardPayment` arguments in `TransactionRow` and `ReimbursableCheckbox`, and in-memory row copies in `lib/category-views.ts`.
     - It guards decision 2 and the #59 defect class.
   - **brand-cast.** `as CategoryData`, `as KindContext`, `as CategoryContext` and `as SpendContext`, including after `as unknown`, are errors outside `lib/category-rules.ts`, `lib/category-context.ts` and `lib/spend-context.ts`.

   **Fixtures.** `scripts/check-invariants.mjs` exports each check as a pure function over `{ path, text }[]`. It walks the tree, prints and exits only when run directly (`import.meta.url === pathToFileURL(process.argv[1]).href`), so `npm run check:invariants` is unchanged.

   `tests/unit/check-invariants.test.ts` imports it (`tsconfig.json:5` has `allowJs`) and feeds it inline fixtures, with at least one must-fire and one must-not-fire case per sub-check:
   - **must fire:** `.update({ user_category: null })` outside the allowed routes, a multi-line update whose third key is `user_category`, and a payload held in a variable;
   - **must not fire:** the `isCreditCardPayment({ …, user_category })` argument shape, and a select string containing `user_category`.

   No fixture file lives under `app/`, `lib/` or `components/`.

   The stale `TXN_READS_ALLOWED` entry for `settings/page.tsx` (`:103`) is removed.
5. **Behavioural page tests** (§11). Each surface seeds one Safeway → Grocery rule and asserts that the page shows Grocery.

**Residual gap:** an `as any`, a type assertion in a file the brand-cast check doesn't scan, or a future aggregator that bypasses `resolveCategory`. Code review is the backstop.

## 8. UI

### 8.1 Transactions: the learned marker

`TransactionRow`'s `categoryName: string` prop becomes `category: ResolvedCategory` (PR 2). The Category cell becomes a single no-wrap flex line (`flex min-w-0 flex-nowrap items-center gap-1.5`):

- **Card payment** (`isCardPaymentRow`, from PR 1): "Card payment" when there's no pick, or the pick's name as plain text when there is one. Neither gets a dropdown, because the server now refuses both changes and the app never offers a control the server would refuse.
- **Every other row:** `CategoryPicker`, plus a link to `/settings#category-rules` **only when `changedByRule`**.
  - The link is `shrink-0` and wraps a new 14px `LearnedIcon` (`components/ui/icons.tsx`).
  - `title` and `aria-label`: "Grocery, learned from Safeway. Manage in Settings → Category rules."

Layout effects:
- The icon is shorter than the select and sits on the same line, so the select still sets the row height (#50).
- The table is `table-fixed` with a flexible Category column, so a marker on one row shifts nothing on the others.
- `isCC` stays, for amount styling and the reimbursable controls.

### 8.2 `CategoryPicker`

- **Honest save**, following `ReimbursableCheckbox` (`components/ReimbursableCheckbox.tsx:51-80`, try/catch/finally). `TimezoneCard` (`components/TimezoneCard.tsx:43-58`) does the same rollback and message with `.catch(() => null)` instead.
  - A save succeeds only when `res.ok && !res.redirected` and the body parses as JSON with `ok: true`.
  - Otherwise roll back to the prop and show the route's message, or "That could not be saved.". A redirected or non-JSON response shows "Your session ended. Sign in again."
  - `setSaving(false)` runs in `finally`, so a network error no longer leaves the select disabled.
  - `router.refresh()` runs only on success.
- **One line, always.** The picker renders its select and its `role="alert"` inside its own `inline-flex min-w-0 flex-nowrap items-center gap-1.5` wrapper, and the alert truncates. So even in PR 1, before §8.1's cell change, an error never adds a line (#50).
- **Follow the server.** Re-sync local state when props change, using the `ReimbursableCheckbox.tsx:38-42` idiom.
  - Without this, creating a rule leaves every other visible Safeway row showing its old category, because `router.refresh()` keeps client state (`node_modules/next/dist/docs/01-app/03-api-reference/04-functions/use-router.md:46`).
  - PR 1 keys on `value`. PR 2 keys on `` `${source}:${value}` ``, which also resets the pending value and any alert when the server's reason for a name changes but the name doesn't. Example: a rule whose category equals a row's bank category is removed, so the row goes from rule to bank.
  - A hand pick never becomes a rule row, because picks can't be cleared (decision 7).

### 8.3 Settings → Category rules

A new client component, `components/CategoryRulesCard.tsx`, rendered in `<Card id="category-rules">` below Categories.

- **Help text:** "When you pick a category for a merchant the app hasn't learned yet, it files that merchant's other transactions the same way, past and future. It never moves money between spending, transfers and income, and never touches card payments."
- **Each rule, sorted by merchant:**
  - **Label.** Truncates, with the full name in `title`.
  - **Count.** "145 transactions · 14 picked by hand". The first number counts non-removed rows where `changedByRule` points at this rule. The second counts the merchant's non-removed rows that carry a hand pick, and is shown only when above zero. Styled `whitespace-nowrap tabular-nums` and never inside a truncating element. Title: "Transactions this rule files under Grocery instead of the bank's category".
  - **A `<select>` of same-kind categories only.**
  - **A Remove button.**
  - Below `sm` the row takes two lines, so nothing is wider than a phone.
- **Change** saves on select, rolling back with an inline alert on failure. There's no confirmation, because picking again undoes it.
- **Remove** opens `ConfirmDialog`, with title "Remove the Safeway rule?" and confirm label "Remove". The body shows only the lines that apply:
  - "145 Safeway transactions go back to their bank's category." (omitted when the count is 0)
  - "14 you picked by hand keep theirs." (omitted when the count is 0)
  - "The next category you pick for Safeway will teach the app again."
- **No current transactions.** A rule whose key matches no non-removed row shows "No current transactions" and its origin. That happens when a bank is disconnected or Plaid renamed the merchant, and the label keeps it from looking broken. Its Remove dialog adds: "No Safeway transactions are showing right now — for example, if a bank is disconnected."
- **Empty state:** "Nothing learned yet. Pick a category on a transaction and the app will remember it for that merchant."
- **Mutations** use `fetch` then `router.refresh()`, the repo's pattern; there are no Server Actions. The §8.2 success rule applies: `res.ok`, not redirected, and a JSON `ok: true`.

### 8.4 Deleting a category

Today's dialog says every transaction "will become Uncategorized" (`components/CategoryManager.tsx:151-157`). That's wrong for hand picks: they take their merchant's rule when one applies, and otherwise their bank category. It would be wrong again for rules.

The dialog shows `deleteImpact`'s result (§7.2), only the lines that apply:
- "{n} will become Uncategorized."
- "{n} will move to {category}", for the top three destinations, then "and {n} more", which counts rows.
- "{rules} merchant rule(s) that file into {category} will be removed."
- "{n} of these will start counting as spending.", shown when `toSpending` is above zero.
- "Its monthly budget will be deleted." / "This can't be undone."

`CategoryUsage` (`CategoryManager.tsx:10`) is `categoryUsage`'s `{ txns, hasBudget }` merged with `deleteImpact`'s result for that category. The Settings help text at `settings/page.tsx:96-98` is corrected to match.

## 9. Seed: `db/seeds/`

Three files, written and reviewed in PR 2. **None is part of setup or the README run order.** README gets one line under the run order pointing to the seed file's header.

| File | Purpose |
| --- | --- |
| `020_category_rules_seed.sql` | Creates the seeded rules. Refuses to run on a non-empty table. |
| `020_category_rules_dry_run.sql` | The same query without the insert: the expected set of rules. |
| `020_category_rules_checks.sql` | Read-only launch checks (§10.2). |

**It runs once per launch, immediately before PR 2 deploys.** Before then, no rule can have been changed or removed through Settings → Category rules. Production still runs PR 1, and local and Preview sessions run sandbox, which the category-rules route's environment guard refuses (§6.2). Because Remove forgets (decision 6), running it again after PR 2 deploys would bring back every seeded rule the household had removed.

**Who gets a rule.** A merchant gets a rule when every eligible hand pick on it names the same category. A pick is eligible when:
- its row is from the live environment, not removed, not a card payment, and has a `merchant_name`;
- its category still exists;
- it doesn't cross the line, under the same two-kind gate as §5.3;
- it isn't the row's bank category.

```sql
-- NOT PART OF SETUP. Run once on production, immediately before the category-rules deploy (PR 2).
-- Never run it again after PR 2 is live: Remove deletes rules, so a re-run brings back every rule
-- the household removed. Never drop, truncate or delete from category_rules: local, Preview and
-- production share this database.
do $$ begin
  if exists (select 1 from public.category_rules) then
    raise exception 'category_rules is not empty: this seed runs once, before PR 2 deploys (spec §9)';
  end if;

  insert into public.category_rules (household_id, merchant_key, merchant_label, category_id, origin)
  with cats as (
    select household_id, id, name, pfc_primary, sort_order,
           case when pfc_primary in ('TRANSFER_IN', 'TRANSFER_OUT') then 'transfer'
                when pfc_primary = 'INCOME' then 'income'
                else 'spending' end as kind
    from public.categories
  ), picks as (
    select t.household_id,
           nullif(lower(regexp_replace(t.merchant_name, '^\s+|\s+$', '', 'g')), '') as merchant_key,
           regexp_replace(t.merchant_name, '^\s+|\s+$', '', 'g')                  as merchant_label,
           p.id as category_id, p.name as pick_name, p.kind as pick_kind,
           bank.name as bank_name,
           -- Plaid's kind for the row (§5.2 bankCategory.kind)
           coalesce(bank.kind,
                    case when t.pfc_primary in ('TRANSFER_IN', 'TRANSFER_OUT') then 'transfer'
                         when t.pfc_primary = 'INCOME' then 'income'
                         else 'spending' end) as bank_kind,
           -- the kind of the name the totals count the row under (§5.2 kindOf(bankCategory.name))
           coalesce(bank.kind,
                    (select u.kind from cats u
                     where u.household_id = t.household_id and u.name = 'Uncategorized' limit 1),
                    'spending') as shown_kind
    from public.transactions t
    join cats p on p.household_id = t.household_id and p.name = t.user_category        -- stale names never seed
    join public.accounts a on a.account_id = t.account_id
    join public.plaid_items i on i.id = a.plaid_item_id
    left join lateral (
      select b.name, b.kind from cats b
      where b.household_id = t.household_id and b.pfc_primary = t.pfc_primary
      order by b.sort_order desc limit 1                                                 -- pfcToName is last-wins
    ) bank on true
    where t.removed = false
      and t.pfc_detailed is distinct from 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT'           -- null-safe
      and i.plaid_env = (select plaid_env from public.app_env)                           -- owner environment only
  ), eligible as (
    select * from picks
    where merchant_key is not null
      and pick_kind = bank_kind                                                          -- the two-kind gate
      and pick_kind = shown_kind
      and pick_name <> coalesce(bank_name, 'Uncategorized')                              -- not a no-op
  )
  select household_id, merchant_key, mode() within group (order by merchant_label),
         (array_agg(category_id))[1], 'seeded'
  from eligible
  group by household_id, merchant_key
  having count(distinct category_id) = 1                                                 -- picks agree
  on conflict (household_id, merchant_key) do nothing;
end $$;
```

- **Dry run.** `020_category_rules_dry_run.sql` is the `with … select … having` query alone, with no insert, no `on conflict` and no guard block.
- **Consistency with the code.** The seed's `bank_kind` and `shown_kind` are §5.2's two kinds. Its key matches `merchantKey` on ASCII, and the launch checks prove every live merchant name is ASCII.
- **Resetting.** Before PR 2 deploys, the reset is `delete from public.category_rules where origin = 'seeded';` followed by running the seed again. Every rule is seeded until PR 3, so this empties the table and the guard allows the re-run. After PR 2 deploys there is no reset; changes go through Settings.

**The per-rule verification query** in `020_category_rules_checks.sql`. It is read-only, with no environment filter, because pages have none:

```sql
with cats as (
  select household_id, id, name, pfc_primary, sort_order,
         case when pfc_primary in ('TRANSFER_IN', 'TRANSFER_OUT') then 'transfer'
              when pfc_primary = 'INCOME' then 'income' else 'spending' end as kind
  from public.categories
), txns as (
  select t.household_id,
         nullif(lower(regexp_replace(t.merchant_name, '^\s+|\s+$', '', 'g')), '') as merchant_key,
         coalesce(t.user_category, '') <> ''                                    as picked,
         coalesce(t.pfc_detailed = 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', false)  as card_payment,
         coalesce(bank.name, 'Uncategorized')                                   as bank_name,
         coalesce(bank.kind,
                  case when t.pfc_primary in ('TRANSFER_IN', 'TRANSFER_OUT') then 'transfer'
                       when t.pfc_primary = 'INCOME' then 'income' else 'spending' end) as bank_kind,
         coalesce(bank.kind,
                  (select u.kind from cats u
                   where u.household_id = t.household_id and u.name = 'Uncategorized' limit 1),
                  'spending')                                                   as shown_kind
  from public.transactions t
  left join lateral (
    select b.name, b.kind from cats b
    where b.household_id = t.household_id and b.pfc_primary = t.pfc_primary
    order by b.sort_order desc limit 1
  ) bank on true
  where t.removed = false
)
select r.merchant_label, c.name as rule_category, x.bank_name,
       count(*) filter (where not x.picked and not x.card_payment
                          and c.kind = x.bank_kind and c.kind = x.shown_kind)                        as labelled,
       count(*) filter (where not x.picked and not x.card_payment
                          and c.kind = x.bank_kind and c.kind = x.shown_kind and c.name <> x.bank_name) as changed,
       count(*) filter (where x.picked)                                                               as picked_by_hand
from public.category_rules r
join cats c on c.id = r.category_id
left join txns x on x.household_id = r.household_id and x.merchant_key = r.merchant_key
group by 1, 2, 3
order by 1, 3;
```

## 10. Delivery

### 10.1 Three PRs

| PR | Contents | Depends on |
| --- | --- | --- |
| **1** | **Code:** §5.2's `lib/categories.ts` exports only (`CREDIT_CARD_PAYMENT_DETAILED`, `isCardPaymentRow`). §6.1 steps 1–7 and 9 (no learning; answers `{ ok: true }`). §8.2 keyed on `value`, with its own one-line wrapper. The §8.1 card-payment cell, still on the `categoryName` prop.<br>**Tests:** `categorize-route.test.ts` (the PR 1 list), `category-picker.test.tsx` (all but the source case), `transaction-row.test.tsx`'s card-payment-with-a-pick case, and `isCardPaymentRow` in `categories.test.ts`. | Nothing. On its own it fixes today's silent picker failures and adds the missing server-side card-payment guard. |
| **2** | **Code:** the migration 020 file (applied when PR 2 development starts, §10.2), the three `db/seeds/` files, the rest of §5, §6.2, §6.3's DELETE guard, §7 including tripwire 4, the §8.1 marker and the `category: ResolvedCategory` prop, §8.2's source key, §8.3, §8.4, and the README run order plus its seed note.<br>**Tests:** every §11 item not in PR 1 or PR 3, including `transaction-row.test.tsx`'s marker and one-line cases and `category-picker.test.tsx`'s source case, plus rewiring existing tests. | PR 1 merged; 020 applied |
| **3** | **Code:** §6.1 step 8 (learning) and the `learned` field.<br>**Tests:** the PR 3 list. | PR 2 |

### 10.2 Order of operations

1. **Before PR 1 deploys:**
   - Back up hand picks: export `id, plaid_transaction_id, merchant_name, date, amount, user_category` for rows with `user_category` set, to CSV. The Free plan has no automatic backups (`docs/plaid-production-cutover.md:44`).
   - Run the card-payment check below; expect 0 rows.
2. **When PR 2 development starts, apply 020.**
   - It creates an empty table that no deployed code reads. It has to go in early because local and Preview share the production database, and without the table the PR 2 pages throw. Precedent: migration 019 was applied to production before merge (`f33c1c2`).
   - Confirm the grants: `has_table_privilege('authenticated', 'public.category_rules', …)` must be true for SELECT, INSERT, UPDATE and DELETE.
   - To review PR 2's marker, counts and Settings card on local or a Preview, run the seed there, then use the §9 reset afterwards. Production code doesn't read the table yet, and Change and Remove answer `409` outside production, so the review is read-only. Change and Remove are covered by their route tests and first exercised live in step 5.
3. **Immediately before PR 2 deploys**, in this order. The checks file holds the queries.
   - Back up hand picks to CSV again.
   - Run `scripts/check-env-contamination.mjs`, which must print Clean.
   - **ASCII:** `select count(distinct merchant_name) from public.transactions where merchant_name ~ '[^ -~]'` must return 0.
   - **Defaults and unmapped primaries:** `select p from unnest(array['INCOME','TRANSFER_IN','TRANSFER_OUT']) p where not exists (select 1 from public.categories c where c.pfc_primary = p)` should return no rows. Then list the primaries of unmapped non-removed rows, and review any `INCOME`/`TRANSFER_*` value with the owner.
   - **Budgets:** `select category from public.budgets`. If any exist, those bars and the dashboard footnote will move at deploy, by design. Record them.
   - **Card payments carrying a pick or a mark:** expect 0 rows.
     ```sql
     select id, merchant_name, date, user_category, reimbursable_amount from public.transactions
     where removed = false and pfc_detailed = 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT'
       and (user_category is not null or reimbursable_amount is not null);
     ```
   - **Seed.** Run the dry run, then the seed, back to back. Diff both ways: `(dry run) except (select household_id, merchant_key, merchant_label, category_id, origin from category_rules)`, and the reverse, must each return 0 rows.
   - **Review.** Run the verification query (§9) and review the per-merchant list with the owner. Every rule must be explained. If the owner rejects one, use the §9 reset. The 2026-09-10 panel probe estimated about 22 rules and 176 changed rows, but it kept picks equal to the bank category, so this seed may produce fewer; the dry run is the expected set.
   - **Record the totals:**
     - the current-month Spent, Income and Saved tiles, and each of the last six months' Income and Spending from the dashboard chart tooltip (`components/SpendIncomeChart.tsx:23-24`);
     - a fingerprint of the rows those totals read:
     ```sql
     select count(*), md5(string_agg(id::text || ':' || amount || ':' || coalesce(user_category,'') || ':' ||
            coalesce(pfc_primary,'') || ':' || coalesce(pfc_detailed,'') || ':' || coalesce(merchant_name,'') || ':' ||
            coalesce(reimbursable_amount::text,''), ',' order by id))
     from public.transactions where removed = false and date >= '<six-month window start>';
     ```
4. **Deploy PR 2, then check:**
   - **Totals.** Compare the six months' figures against a local checkout of PR 2's parent commit reading the same database at the same moment (local reads the shared database). They must match to the cent. If the fingerprint is unchanged since step 3, the step-3 figures must match too.
   - **Settings counts.** For every rule, "N transactions" equals the sum of `changed` over that rule's rows in a verification query run just before, and "M picked by hand" equals the sum of `picked_by_hand`. A difference not explained by rows synced in between blocks PR 3.
   - The Grocery drill-down lists Safeway rows.
   - The Spent tile equals the sum of its Breakdown rows.
   - Only the budget bars recorded in step 3 may move.
5. **Deploy PR 3.** Learning can only be exercised on production, because rule writes are environment-guarded. Test it on a merchant with exactly one non-removed transaction, so the rule relabels nothing and no total moves:
   - pick the category that transaction genuinely belongs in, not its bank category (which teaches nothing). A pick can't be cleared (decision 7), so the test pick must be one the household wants to keep;
   - confirm the rule with a read-only SELECT;
   - Change the rule, then Remove it;
   - confirm with SQL that no rule remains for that merchant.

Picks made between PR 2 and PR 3 don't teach; the merchant's next pick after PR 3 does.

### 10.3 If something goes wrong

- **PR 2 deployed before 020, or without its grants.**
  - Dashboard, Transactions, Budgets, Trends and Breakdown (spent/saved) show `app/(app)/error.tsx`'s retryable card.
  - In production and on Preview the card's message is Next's generic Server Components message with a digest (`error.md:111`). The underlying `could not read category rules: … (has db/migrations/020, including its grants, been applied?)` is in the Vercel runtime logs for that digest; locally, `next dev` shows it on the page.
  - Settings shows its inline alert, and Banks keeps working.
  - Bank sync is unaffected, because ingest never reads the table, and PR 1's route still saves picks.
  - There is deliberately no "table missing, so no rules" fallback: it would silently revert every learned label.
- **Rollback.**
  - Revert PR 3, then PR 2 (PR 3 imports PR 2's lib). Labels return to their pre-#28 state on the next render.
  - Rules never write `user_category`, so there's nothing to restore, and the CSV covers mistaken hand changes.
  - To remove the schema as well, once no deployment built from PR 2 is live, drop `category_rules` before the `categories_household_id_id_key` constraint its FK depends on.

## 11. Testing

CI runs typecheck (tests included), lint, the suite in two timezones, secrets, invariants and build (`.github/workflows/ci.yml:41-66`). Vitest collects `tests/unit/**/*.test.ts(x)` (`vitest.config.mts:18`). Items not marked (PR 1) or (PR 3) belong to PR 2.

**`tests/unit/category-rules.test.ts`**: table-driven `resolveCategory`:
- a hand pick beats a rule, and a rule applies when there's no pick;
- a card payment with merchant `Safeway` and a Safeway rule gets the bank category, and with a pick it keeps the pick;
- `merchant_name` `null`, `''` and `'  '` never match; `' SAFEWAY '` matches `safeway`; `Walmart+` does not match `walmart`;
- a spending rule on a `TRANSFER_OUT` row gives the bank category;
- a spending rule on an `Uncategorized` row with a spending primary gives the rule;
- **after "Transfer Out" is deleted:** a spending rule on a `TRANSFER_OUT` row doesn't apply, **and** a Transfer In rule on that row doesn't apply; the row shows `Uncategorized`;
- **after "Income" is deleted:** a spending rule on an `INCOME` row doesn't apply;
- a rule whose category is missing from the context gives the bank category;
- `bankName` is correct, and `changedByRule` is false when the rule's category equals the bank's;
- `buildCategoryContext(data, { withoutCategoryId })` drops that category and its rules;
- `buildCategoryContext` throws on rules from two households;
- `// @ts-expect-error` on a literal context and on `{ categories, rules: [] }`.

**Money properties** (`spendByCategory` and `monthlyFlows` with rules):
- Safeway spend moves from Food & Drink to Grocery;
- a matching card payment stays out of both totals;
- a refund nets the rule's category down;
- **Spent and Income are identical under any rule set**, the property test for decision 4. It runs over category sets with each of Income, Transfer In and Transfer Out deleted in turn, and with a category named "Uncategorized".

**`lib/category-views.ts`**, run against the real functions:
- **Parity.** For every category X with `kindOf(X) === 'spending'` and every month M, `(spendByCategory[X] ?? 0)` equals the sum of `spendableAmount` over `filterByCategory(X)` in M. The fixture includes an unpicked Loan Payments card payment.
- **Income parity.** For every month M, the income total from `monthlyFlows` equals the sum, over income-kind categories X, of −`spendableAmount` over the inflows of `filterByCategory(X)` in M.
- **Usage parity.** For every category X, `categoryUsage[X].txns === filterByCategory(rows, X, ctx).length`, on the same fixture.
- `filterByFlow` returns the same rows with and without a Safeway → Grocery rule.
- `activityItem` labels a Safeway row Grocery.
- **`deleteImpact`:**
  - a pick of the deleted category on a merchant with a same-kind rule counts as moving to the rule's category;
  - a pick of the deleted category is never counted as staying;
  - deleting Transfer Out counts its rows as `toSpending`;
  - `movedMore` counts rows.

**`tests/unit/category-context.test.ts`:**
- exact throw messages for each failed read;
- the keyset reader returns 1,238 rows from pages of 1,000, 238 and 0;
- a server capped at 500 rows per page still returns every row;
- an error on the second page throws;
- rules spread across two keyset pages (1,000, then 1, then 0) all reach `CategoryData`;
- a local function declared `Promise<(CategorizableTxn & { id: string })[]>` that returns a keyset read selecting no `merchant_name` carries `// @ts-expect-error`.

**Routes** (patterns: `household-timezone-route.test.ts`, `reimbursable-route.test.ts`, `manual-assets-env.test.ts`):
- **`categorize-route.test.ts` (PR 1):**
  - `400` on malformed JSON and on an empty category, with no database call;
  - `401`, and `404`;
  - `400` on a removed row;
  - `400` on a card payment, including one with a pick;
  - the categories read selects `pfc_primary`, filters by the row's household and orders by `sort_order`; a read error gives `500` with no update call;
  - `400` on an unknown category;
  - the update carries `removed = false`, the null-safe card filter and `{ count: 'exact' }` (assert the options argument, since stubs otherwise ignore it);
  - an update error gives `500` without database text;
  - a count of 0 gives `409`;
  - the previous category is logged;
  - the response is `{ ok: true }`.
- **`categorize-route.test.ts` (PR 3):**
  - the exact upsert payload and options;
  - one returned row gives `created`;
  - no learning for a crossing pick, a null merchant, a pick equal to the bank category, or a pick on a `TRANSFER_OUT` row after "Transfer Out" is deleted;
  - a card payment gives `400`, with no upsert call;
  - no returned rows gives `exists`, with the pick saved;
  - an upsert error gives `200 failed` plus the log tag;
  - an environment mismatch gives `200 skipped`, and an unreadable environment gives `200 failed`, each with the pick saved.
- **`category-rules-route.test.ts`:**
  - Change to a same-kind category gives `200`, filtered on `expectedCategoryId` and called with `{ count: 'exact' }`;
  - Change to the current category gives `200` with no update call;
  - a missing rule gives `404`, and a stale `expectedCategoryId` gives `409`;
  - a cross-kind Change gives `400`, and so does an unknown target;
  - a count of 0 gives `409`, and so does `23503`;
  - Remove is filtered on `expectedCategoryId` and called with `{ count: 'exact' }`; a count of 0 gives `409`;
  - `401`, `403`, and the environment's `409`/`500`.
- **`categories-route.test.ts`:** DELETE answers the environment's `409`/`500` and makes no `categories`, `transactions` or `budgets` call.

**Components:**
- **`category-picker.test.tsx` (new; PR 1 except the source case):**
  - rolls back on `400` and on a network error;
  - rolls back on a redirected `200` response, and doesn't refresh;
  - is re-enabled afterwards;
  - renders the alert inside its one-line wrapper;
  - (PR 2) after a failed save, clears its alert when `source` changes from rule to bank and the name stays the same.
- **`transaction-row.test.tsx`:**
  - (PR 1) a card payment with a pick shows plain text;
  - the marker appears only when a rule changed the name;
  - the cell stays one no-wrap line with no block element;
  - existing assertions unchanged; the shared `renderRow` helper (`:26`) passes a `ResolvedCategory` instead of `categoryName="Food"`.
- **`category-rules-card.test.tsx` (new):**
  - only same-kind options are offered;
  - the count never truncates;
  - the Remove dialog omits zero counts and says the next pick teaches;
  - the "No current transactions" state;
  - rollback on a failed or redirected Change.
- **`CategoryManager` delete copy:**
  - Uncategorized vs moved destinations;
  - rules removed;
  - the "start counting as spending" line appears only when `toSpending` is above zero.

**Pages.** Dashboard, budgets, trends, breakdown, settings, and a new minimal transactions-page test. Page tests mock `@/lib/category-context`, so keyset paging is exercised once, in its own test.
- **Relabel.** Each seeds one Safeway → Grocery rule and a Safeway Food & Drink row, and asserts the relabel:
  - Dashboard: on `RecentActivity`'s `items` prop.
  - Breakdown: a Grocery row in `BreakdownList` on `spent`, and unchanged Money in and Money out on `saved`.
  - Budgets and Trends: through their `spend` data.
  - Transactions: each row's `category.source`.
  - Settings: the per-rule counts.
- **Failure.** Each throws when the mocked `fetchCategoryContext` rejects. Settings instead renders BankList and the inline alert, and does the same when `readTransactionsForCounts` or the budgets read fails.

**Existing tests rewired (PR 2).** Assertions keep their meaning.
- `effective-category`, `spend-context`, `budget`, `dashboard`, `trends-view` and `reimbursement-reconciliation` build contexts through `tests/unit/helpers/`.
- `spend-context` asserts through `kindOf` and `resolveCategory` instead of the private maps, and adds a case resolving a rule through a built `SpendContext`.
- `dashboard.test.ts` keeps "honors a user override on a credit-card payment" as is.
- `Txn` and `FlowTxn` fixtures gain `merchant_name: null`.
- The existing "could not read categories" page tests (`dashboard-page.test.tsx`, `trends-page.test.tsx`) make the mocked `fetchCategoryContext` reject with that message.
- `budgets-page.test.tsx`'s stub becomes per-table.

**Invariants.** `tests/unit/check-invariants.test.ts` runs the §7.4 fixtures against the exported checks.

## 12. Known trade-offs

- **One pick has a silent, merchant-wide, retroactive effect.** A mistaken first Chipotle pick relabels every Chipotle row. Fix it with Change or Remove in Settings; the mistaken row itself needs a new pick.
- **A merchant that fits no single category re-learns after Remove** (decision 6).
- **A hand pick can't rejoin its rule, and a card payment carrying a pick keeps counting** (decision 7).
  - None exist today, but one can appear later if Plaid re-tags a picked row as a card payment (`lib/ingest.ts:57, 113-117`).
  - Such a row also keeps its reimbursable controls, which key on `isCreditCardPayment`. That is pre-existing behaviour.
  - The §10.2 card-payment query finds such rows; the remedy is a reviewed SQL update.
- **Rows whose default Income or Transfer category was deleted take no rule** (§5.2). Money stays where the totals already count it.
- **One rule per merchant, across kinds.** A merchant with both transfer and spending rows can learn only one side. No merchant mixes them today (0 of 281).
- **`merchant_name` belongs to Plaid.** A rename silently starts or stops a match; the only sign is the Settings count changing. Rows with no merchant name never learn.
- **Settings reads every transaction** to count exactly: three requests today.
- **The category drill-down inherits the transactions page's 200-row cap** (§7.2). Settings' per-rule counts, which read every row, are the complete view of a rule.
- **The seed restates the kind gate and the key in SQL.** It runs once, at launch, and is checked three ways: the dry-run diff, the ASCII check, and Settings' per-rule counts matched against the verification query after deploy.
- **Rules can only be created, changed or removed in production**, including through a category delete. So learning is tested there (§10.2).

## 13. Out of scope

- Matching on Plaid's `merchant_entity_id`, which needs an ingest column and a backfill.
- An "Automatic" option that clears a hand pick (decision 7).
- Carrying a pick from a pending row to its posted row when no rule covers it.
- Refusing a reimbursable mark on a card payment that carries a pick. That belongs in a separate issue.
- #69's other reads, and #91's remaining unchecked reads (`settings/page.tsx:25`, the `lib/` helpers, the webhook).
- Hardening the category rename and delete cascades on `user_category` and `budgets`.
- Explicit grants for migrations 001–019 on a fresh project.
- Redirect-safe saves in the repo's other client mutations.
- Separate rules for a merchant's spending and transfer rows.
- #66, bulk recategorize. It will reuse §6.1's hardened route and `buildKindContext`.
