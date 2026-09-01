# Environment Write Guard — Design Spec

- **Repo:** `smilne3/every-dollar-counts`
- **Date:** 2026-09-01
- **Closes:** #23 (sandbox banks can count toward real net worth)
- **Status:** Approved design, ready for implementation plan
- **One line:** The database records which Plaid environment it belongs to, and the two functions that write bank data refuse to run against a database from a different one — closing #23 at its single entrance instead of filtering fourteen exits.

---

## 1. Why this exists

One Supabase project serves local dev, Vercel Preview and production. Local and Preview both run `PLAID_ENV=sandbox` by design, so a sandbox bank linked from a laptop writes `accounts` and `transactions` rows into the same database production reads from.

`plaid_env` exists on `plaid_items` and is filtered everywhere that table is read. It does **not** exist on `accounts` or `transactions`, and no money read filters on it. So a sandbox bank linked after go-live would count toward net worth and cash on hand with invented balances, inflate spending and budgets, and be **impossible to remove from the Settings page** — because the bank list *is* environment-scoped, so the item is hidden while its accounts still count.

This is a latent seam, not a live bug. It is closed today only by a standing rule in the cutover runbook: *never link a bank from a local or Preview session against the live database.* This spec turns that rule into code.

## 2. The decision

**Block the write, don't filter the reads.** #23 proposes denormalising `plaid_env` onto both tables and filtering every money read. We are not doing that. Three reasons:

**The surface is lopsided.** A full inventory of the repo found:

| | Count | Where |
|---|---|---|
| Functions that **create** account/transaction rows | **2** | `storeAccounts`, `syncAndStore` — both in `lib/ingest.ts` |
| Places that **read** them for money | **~14** | dashboard, transactions, trends, budgets, breakdown, reimbursements, settings, `lib/receivable.ts`, `lib/manual-assets.ts` |

#23 listed six read sites when it was filed. A month of new pages has made it fourteen. Two doors versus fourteen windows.

**We already ran this experiment and it failed.** Migration `011_manual_assets.sql:9` added `plaid_env` to `manual_assets` under the comment `-- Not filtered on yet.` A month later `lib/manual-assets.ts:11` still does not filter on it. One table, one read site, one explicit note-to-self — and it still decayed. Correctness that depends on remembering to add a line at every new call site does not survive contact with a growing app.

**The failure directions are not symmetric.**

| Approach | What a mistake looks like |
|---|---|
| Filter the reads | Real transactions silently vanish from the dashboard. #23 warns about this itself: a row written without the stamp gets the `'sandbox'` default and is then filtered *out* of production. "The failure inverts and gets worse." |
| Guard the writes | A bank link is refused with a clear error message. |

Wrong is worse than stopped. On a money app, a sync that halts loudly beats one that quietly reports the wrong number.

## 3. The mechanism

The database records its own identity, in a single-row table:

```sql
create table if not exists app_env (
  id boolean primary key default true check (id),  -- only one row can ever exist
  plaid_env text not null check (plaid_env in ('sandbox','development','production')),
  updated_at timestamptz not null default now()
);
```

Seeded from the newest `plaid_items` row, so production says `production` and a fresh dev database says `sandbox`, with nothing hardcoded and nothing to configure:

```sql
insert into app_env (id, plaid_env)
values (true, coalesce(
  (select plaid_env from plaid_items order by created_at desc limit 1),
  'sandbox'))
on conflict (id) do nothing;
```

**Why in the database rather than an environment variable.** The database is the thing being protected, so it carries its own identity. A `.env` file on a laptop can point anywhere — that is precisely the hole #23 describes. A database that knows what it is cannot be lied to by a laptop.

## 4. Where the guard goes

The inventory narrowed the danger to a **single door**. The sync, webhook and reconnect paths already filter `plaid_items` by environment, so pointed at the wrong database they find nothing and write nothing — already safe. The only genuinely dangerous path is linking a *new* bank, which is what creates the mis-stamped item in the first place.

The assertion itself lives in a new `lib/app-env.ts` — not inside `lib/ingest.ts`, because routes outside ingest need it too. One function, one job, testable on its own.

It is applied at every place this app writes household financial data:

| Call site | On mismatch |
|---|---|
| `app/api/plaid/exchange-public-token/route.ts` — **before** the `plaid_items` insert | `409` with a plain-English reason |
| `lib/ingest.ts` → `storeAccounts` | Throws |
| `lib/ingest.ts` → `syncAndStore` | Throws |
| `app/api/manual-assets/route.ts` — the POST | `409` |

Checking *before* the `plaid_items` insert matters: a guard that fired later would leave an orphaned bank row behind. The two `ingest.ts` assertions are backstops — the sync, webhook and reconnect paths are already safe — so that a future write path cannot quietly reopen this.

**Caching.** The value cannot change under a running process, so it is read once and memoised. A *failed* read is never cached — otherwise one transient blip would poison the process for its whole life, and the fail-closed behaviour below would turn a moment's trouble into an outage.

**Fails closed.** If the row is missing or unreadable, the guard refuses rather than assuming it is fine. The cost is real and accepted: a botched migration stops Refresh working until it is fixed. That is the correct direction — a halt is noticed within minutes, silently untagged data is not.

## 5. Cleanup and verification

`accounts` and `transactions` are **already environment-attributable** through existing foreign keys — `accounts.plaid_item_id → plaid_items.plaid_env`, and transactions chain through `accounts.account_id`. No new column is needed to find or remove contamination, and `scripts/reset-plaid-data.mjs` already deletes sandbox rows.

Step one of implementation is therefore a **read-only** check confirming the live database has no cross-environment rows today. Expected clean — the pre-cutover reset handled it — but verified, not assumed. Requires the user's approval before connecting to production.

**The `manual_assets` loose end is closed by guarding, not by filtering.** Migration 011 left `plaid_env` on that table with `-- Not filtered on yet.`, anticipating a read filter. Under this design that filter is never coming: guarding the write in `app/api/manual-assets/route.ts` (§4) means a wrong-environment row cannot be created, so there is nothing to filter out. The migration comment gets corrected to say so, and the column stays as a harmless record of which environment created each row.

## 6. Testing

| Case | Expected |
|---|---|
| App environment matches the database | Write proceeds |
| App environment differs | Throws; nothing written |
| `app_env` row missing | Throws (fails closed) — *not* "assume it's fine" |
| Read of `app_env` fails, then succeeds | Second call retries and succeeds — the failure was not cached |
| Bank link from a mismatched environment | `409`, and **no `plaid_items` row created** |
| Manual asset POST from a mismatched environment | `409`, nothing written |

Route coverage follows the pattern established by `tests/unit/reimbursable-route.test.ts`: mock `@/lib/supabase/admin`, build a real `Request`, call the exported handler.

## 7. Explicitly not doing

- **No `plaid_env` column on `accounts` or `transactions`.** Their environment is already derivable through the foreign keys.
- **No changes to any of the ~14 money read sites.** Untouched reads cannot regress.
- **No backfill against live bank data.** The migration adds one row to one new table and touches nothing existing.

## 8. Consequences

**Linking a sandbox bank locally will now be refused** with a clear error. This is intended: the user confirmed sandbox linking is finished now that the app runs on real accounts. If it is ever needed again, the fix is a separate dev Supabase project — which is the right answer regardless, and would also stop a laptop reading real bank transactions.

**No Plaid quota impact.** This change makes no Plaid API calls and creates no Items. (Noted because the account is on the Trial plan, capped at 10 Production Items, and `/item/remove` does not free a slot — a real constraint, but unrelated to this work.)

## 9. Rejected alternatives

**Denormalise `plaid_env` onto both tables and filter every read** (#23's own proposal). Rejected on the three grounds in §2: fourteen read sites and growing, a failed precedent in this same repo, and a failure mode that hides real money.

**Nested joins at each read site** (also tested in #23). Rejected there and here: the embeds change the returned row shape at every call site, for the same per-read-site fragility.

**A second Supabase project for local and Preview.** The most complete fix, and it would also stop local dev reading real bank data. Rejected *for now* as disproportionate — a second database to keep migrated and seeded, to close a seam this guard closes in one file. Revisit if sandbox linking is ever needed again (§8).
