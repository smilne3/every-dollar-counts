# Dashboard Drill-Down — Design Spec

- **Repo:** `smilne3/every-dollar-counts`
- **Date:** 2026-07-25
- **Issue:** #24
- **Status:** Approved design, ready for implementation plan
- **One line:** Make the dashboard's headline numbers clickable, so you can drill from a tile down to the accounts or categories that make it up, and then to the individual transactions.

---

## 1. Purpose

UAT revealed that testers clicked the dashboard's summary tiles — Net Worth, Cash on Hand, Spent, Saved — expecting them to open up and reveal what they're made of. Today the tiles are dead ends. This feature makes each one a doorway: tile → the things that total it → the transactions underneath.

**Success looks like:** clicking "Cash on Hand" shows the depository accounts that sum to it; clicking one of those accounts shows its transactions. The same drill pattern works from all four tiles.

## 2. What's already in place (shrinks the job)

- The roll-up math already exists and is unit-tested: `netWorth`, `cashOnHand`, `monthlyFlows` in `lib/dashboard.ts`; `spendByCategory` in `lib/budget.ts` (now correct for refunds and credit-card payments, as of #8/#31).
- `TransactionRow` + `CategoryPicker` already render a transaction with re-categorization.
- The `/transactions` page already lists transactions and supports a search (`?q=`) filter.
- `StatCard` renders each tile.

No new math is introduced. This feature is navigation and presentation over data and calculations that already exist.

## 3. Key decision: level 2 reuses the Transactions page

Two levels of drill-down:

- **Level 1 — the breakdown page** (new): what sums to the tile.
- **Level 2 — the transactions** (reuses `/transactions`, made filter-aware).

**Decision: reuse the existing `/transactions` page for level 2, filtered by URL params**, rather than building bespoke transaction lists inside each breakdown page. Clicking an account row goes to `/transactions?account=<id>`; a category row goes to `/transactions?category=<name>&month=<YYYY-MM>`.

Why: the Transactions page already renders transactions with search and re-categorization. Reusing it keeps one transaction view in the app (consistent, DRY, no drift), gives re-categorization inside the drill-down for free, and makes the Transactions page independently filterable as a bonus. The alternative — mini transaction lists per breakdown — re-implements rendering and loses re-categorization.

## 4. Routes and flow

Tiles become links to a shared breakdown route:

| Tile | Level 1 (`/breakdown/<metric>`) shows | Level 2 (row → `/transactions?…`) |
| --- | --- | --- |
| Net Worth | accounts grouped **Assets vs Liabilities**, each balance; asset subtotal, liability subtotal, net | account row → `?account=<id>` |
| Cash on Hand | depository accounts + total | account row → `?account=<id>` |
| Spent (this month) | spending by category this month (net of refunds) + total | category row → `?category=<name>&month=<YYYY-MM>` |
| Saved (this month) | two rows — Income in, Spending out — + the net | Income → `?month=…&flow=in`; Spending → `?month=…&flow=out` |

Time scope matches the tile: Net Worth and Cash are current balances (their level-2 transaction lists are the account's recent transactions, unfiltered by month); Spent and Saved are this-month, so their level-2 lists carry `month=<current>`.

**Filter semantics, pinned to remove ambiguity:**
- `account=<id>` filters `transactions` on `account_id` (Plaid's text id, the column transactions store). The breakdown passes the account's `account_id`, not the internal `accounts.id` uuid.
- `category=<name>` filters on the transaction's *effective* category (user override, else the PFC→name mapping) — the same categorisation the totals use — so the filtered list sums to the row you clicked.
- `flow=out` shows transactions in **spending** categories for the month — both purchases and their refunds (a refund is a negative-amount row in a spending category), so the list reconciles to the netted "Spending out" figure. `flow=in` shows inflows in **income** categories. Transfers and credit-card payments are excluded from both, matching `monthlyFlows`.

## 5. Components and boundaries

**Create:**
- `app/(app)/breakdown/[metric]/page.tsx` — one dynamic route; a thin server component that, per `metric`, fetches the data and renders the roll-up. Unknown metric → `notFound()`.
- `components/BreakdownList.tsx` — the shared presentational list: rows of (label, sub-label, amount, optional drill href) plus subtotal/total rows. One component, four callers.
- `lib/breakdown.ts` — pure helpers: group accounts into assets/liabilities for display; assemble each metric's rows. Unit-tested.

**Modify:**
- `components/ui/StatCard.tsx` — optional `href`; when present the card is a link with a subtle affordance (chevron/hover).
- `app/(app)/transactions/page.tsx` — accept `account`, `category`, `month`, `flow` params and filter accordingly; show a "filtered by …" chip with a clear-filter link. Keeps the existing `q` search.

## 6. The four breakdowns in detail

- **Net Worth** — every account, split into Assets (`depository`, `investment`, `other`) and Liabilities (`credit`, `loan`), each shown at its balance (liabilities shown as amounts owed). Subtotals for each side and the net. Reuses the exact type sets in `lib/dashboard.ts` so the page and the tile can never disagree.
- **Cash on Hand** — the `depository` accounts and their total; mirrors `cashOnHand`.
- **Spent** — `spendByCategory` for the current month, one row per category with spend, sorted high to low, plus the total. Net of refunds and excluding credit-card payments (already handled by that function).
- **Saved** — the current month's Income and Spending from `monthlyFlows`, and the net (what "Saved this month" shows). Two drillable rows.

## 7. Edge cases

- **Balances-only accounts** (investments, the mortgage) have no transactions. Their level-2 view shows "Balances only — no transactions to show here," not a blank/broken list.
- **Empty category / account / zero metric** → a plain empty state ("No transactions this month").
- **Unknown `metric`** in the route → `notFound()`.
- **`plaid_env` scoping (#23):** every breakdown query and the new transactions filters are scoped to the current environment (join through `plaid_items` on `plaid_env`), so this feature does not widen #23 — and the filter-aware transactions query is the first read path to close it. (Full closure of #23 across all money reads remains its own issue.)

## 8. Testing

- `lib/breakdown.ts` pure helpers get unit tests: asset/liability grouping (including null balances and unknown types), and the row assembly for each metric.
- The roll-up functions are already unit-tested; the breakdown pages must render the *same* totals as the tiles — a test asserts the breakdown's computed total equals the tile's function output for a shared fixture.
- Pages, links, and the transactions filters are verified by `tsc`/lint/build plus a manual click-through: tile → breakdown → transactions, for each of the four, including a balances-only account and an empty category.

## 9. Out of scope

- Editing or reordering from the breakdown views — they are read/drill only (re-categorization still happens on the Transactions page).
- Charts or trends inside the breakdowns — this is drill-to-detail, not new visualization.
- Fixing the 200-row cap on the transactions list (#7) or the full #23 closure — separate issues; this feature is built not to worsen them.
