# Plaid Production — Design Spec

- **Repo:** `smilne3/every-dollar-counts`
- **Date:** 2026-07-14
- **Status:** Approved design, ready for implementation plan
- **One line:** Point the app at real banks instead of Plaid's fake ones, and make sure it keeps working after they break.

---

## 1. Purpose

The v1 feature set is done and running against Plaid's sandbox — every bank on the dashboard is
fake and every transaction is invented. This is the step that makes the app real: our actual
bank, our actual credit cards, our actual money.

"Just flip an environment variable" is most of it and none of it. The variable is already there.
What sandbox never made us build is the part where a real bank hands the login off to its own
website, and the part where a real connection breaks a month later and quietly stops syncing.

**Success looks like:** Sarah links the household's real bank, credit cards, and brokerage on the
live site; the dashboard shows true balances, true transactions, and a true net worth; and when a
bank connection eventually breaks, the app says so and offers a fix instead of failing silently.

## 2. What's already in good shape

Worth stating, because it shrinks the job:

- `lib/plaid.ts` already switches between sandbox and production on `PLAID_ENV`.
- The Plaid access token is already encrypted at rest (AES-256-GCM, `lib/crypto.ts`) and lives in
  a table with **no client policy at all** — unreachable from the browser under any session.
- Row-level security already scopes every table to the household.
- `netWorth()` in `lib/dashboard.ts` already treats `investment` accounts as assets.

None of that changes. This spec is about the gaps sandbox let us ignore.

## 3. The Plaid account (dashboard work, not code)

Plaid retired the old middle tier: Limited Production closed to new signups in April 2026. That
leaves two ways in, and we've chosen the second.

**Decision: full Production on the Pay-as-you-go plan.**

The alternative was Plaid's **Trial plan** — free, real bank data, OAuth banks included, no
paperwork at all, but capped at **10 Items** (one Item = one bank login), and `/item/remove` does
not give a slot back. Expected usage is only 4–6 logins, so the cap probably would never have bitten.

We're going to Production anyway, deliberately: this is the household's real money, not a toy tier,
and the cost is genuinely small — Pay-as-you-go carries **no minimum and no commitment** (Plaid
positions it for hobbyists) and bills Transactions as a per-bank monthly subscription, on the order
of a few dollars a month for our handful of accounts. Exact rates are shown during the application.

**What it costs instead is paperwork and a queue**, and this is the part to take seriously:
Production requires application display info, company information, agreeing to the MSA, and
**Plaid's security questionnaire** — which is specifically what gates access to OAuth banks like
Chase. Plaid says to submit it early because review takes time.

**This is a one-way door: once the Production application is submitted, the free Trial plan is no
longer available as a fallback.** Accepted knowingly.

**Therefore the application is submitted immediately, in parallel with the build** (§11 verifies
everything in sandbox regardless, so Plaid's review clock runs alongside the work instead of after
it). Draft answers, grounded in this app's actual architecture, live in
`docs/plaid-production-application.md`.

To set up, in order:

1. Submit the Production access application (display info, company info, MSA, security
   questionnaire). **Do this first — it's the long pole.**
2. On approval: copy the **production** `client_id` and `secret` (different values from the sandbox
   ones).
3. Register the OAuth redirect URI: `https://every-dollar-counts.vercel.app/plaid/oauth`.
4. Set the app display name so the bank's consent screen says "Every Dollar Counts."

Item slots are no longer scarce on this plan — but every linked bank is a real monthly charge and a
real credential, so §11 still proves each flow in sandbox before spending one.

## 4. Code change 1 — OAuth redirect

Sandbox banks accept a username and password inside the Plaid Link popup. Real banks don't: they
bounce the user out to the bank's own website, take the login there, and send them back. That
handoff is what the redirect URI is for, and nothing in the current code does it. Without it, Chase
and friends will not open at all.

- `create-link-token` passes `redirect_uri` (from an env var, so sandbox and production differ).
- New route `/plaid/oauth` — the page the bank returns you to.
- `LinkButton` persists the link token (`localStorage`) before opening Link, so the OAuth page can
  re-initialize Link with the *same* token and finish where it left off. The received
  `public_token` then goes to the existing `exchange-public-token` route unchanged.

## 5. Code change 2 — two kinds of "add account"

Plaid Link only shows institutions that support **every** product in the request. Today the link
token asks for `transactions` alone, which means a pure brokerage (Vanguard, Schwab) never appears
in the list. Adding `investments` to the same request would shrink it the other way and start
hiding ordinary banks.

So one button becomes two paths:

| What you're adding | Products requested | What we ingest |
| --- | --- | --- |
| Bank or credit card | `transactions` | Balances + transactions |
| Investment account | `investments` | **Balances only** |

**Balances only is deliberate.** The brokerage's total value flows into net worth (which already
counts it) and nothing else. We do not ingest holdings or trades — that's a portfolio tracker, and
this is a budget tracker.

Schema: `plaid_items` gets a `products text[]` column recording which path created it.

## 6. Code change 3 — sync respects the products column

`sync-transactions` currently loops every item and calls `/transactions/sync` on all of them, which
would throw the moment a brokerage exists. It must:

- Refresh balances for **every** item (`storeAccounts` — this is what makes brokerage net worth work).
- Call `/transactions/sync` **only** for items whose `products` include `transactions`.
- Skip items marked `needs_reconnect` (§7) rather than hammering a connection that's known broken.

`exchange-public-token` has the same problem — it unconditionally calls `syncAndStore` right after
linking — and gets the same fix.

## 7. Code change 4 — reconnect when a bank kicks you out

Real connections break: password changes, new MFA prompts, expiring bank consent. Today the app
handles this by doing nothing visible — sync stops returning transactions and no one finds out
until they notice the numbers went stale. On real money that's the worst possible failure.

- `plaid_items` gets `status` (`ok` | `needs_reconnect`) and `status_detail`.
- Sync catches Plaid's `ITEM_LOGIN_REQUIRED` / `PENDING_EXPIRATION`, sets the status, and moves on
  to the next bank rather than failing the whole refresh.
- The dashboard shows a broken bank plainly, with a **Reconnect** button.
- Reconnect creates a link token in **update mode** (the item's `access_token`, no products) and
  reopens Link. On success the status clears and syncing resumes — **no new Item is consumed.**

## 8. Code change 5 — disconnect a bank (closes #11)

Currently there's no way to remove a bank, which matters more when the credential is real.

- New route: call Plaid's `/item/remove`, then delete the item.
- **A bug this surfaced:** `transactions.account_id` is a plain `text` column with no foreign key to
  `accounts`. Deleting an item cascades to its accounts but leaves its transactions **orphaned** in
  the table, where they'd go on counting toward spending forever. Fix it in the database, not in
  application code: add the missing foreign key
  (`transactions.account_id → accounts.account_id ON DELETE CASCADE`) so removing a bank cleans up
  after itself the same way removing a household already does.
- **Ordering matters:** that constraint can't be added while orphaned rows exist, so the sandbox
  reset (§9) runs *before* the migration. Clean slate first, then the guardrail.
- The confirmation dialog says plainly that the Plaid slot does **not** come back.

## 9. The clean cut from sandbox

Sandbox access tokens are worthless against the production API — they don't fail gracefully, they
just fail. And the dashboard is currently full of fake banks with invented transactions.

Before flipping `PLAID_ENV`, delete every `plaid_item`, its `accounts`, and its `transactions`.

**Keep** the household, the memberships, the categories, the budgets, and the goals. Those are real
decisions Sarah made, not fake data, and they'll apply to the real numbers when they land.

Delivered as a one-off guarded script (`scripts/reset-plaid-data.mjs`) that requires an explicit
confirmation flag, so it can't be run by accident.

## 10. Environments and secrets

| Where | `PLAID_ENV` | Why |
| --- | --- | --- |
| Local dev | `sandbox` | Can't burn an Item slot or touch a real bank by accident |
| Vercel preview | `sandbox` | Same |
| Vercel production | `production` | The only place real banks are linked |

Production Plaid keys are set on Vercel production **only**. `TOKEN_ENCRYPTION_KEY` is ours, not
Plaid's, and does not change. `PLAID_REDIRECT_URI` is new and differs per environment.

This falls out of the OAuth requirement anyway: the redirect must be a registered HTTPS URL, so
real bank linking happens on the live site, not on localhost.

## 11. How we verify

Everything is proven in sandbox before a real credential or a real charge is involved. This also
means the build is **not blocked** on Plaid's review of the Production application (§3) — steps 1
and 2 need nothing from Plaid but the sandbox keys we already have.

1. **Sandbox, OAuth test bank.** Plaid's sandbox includes an OAuth institution. Exercise the full
   redirect round-trip there and confirm a bank links end to end.
2. **Sandbox, the rest.** Reconnect (Plaid can force an item into `ITEM_LOGIN_REQUIRED` on demand)
   and disconnect, including confirming the transactions actually leave the table.
3. **Production, one real bank.** Link it. Confirm the transactions are ours, the balance matches
   what the bank's own website says, and Refresh pulls new activity.
4. **Production, the rest.** Brokerage and credit cards. Confirm net worth against a number we
   already know to be true.

Steps 3–4 wait on Production approval. If approval lands before the code is ready, nothing changes;
we still don't skip 1 and 2.

## 12. Explicitly out of scope

- **Webhooks** (#14) and **nightly cron** (#15) — Refresh stays a button you press.
- **Holdings and trades** — balances only, per §5.
- The existing known bugs stay open. But fair warning: **#8 (refunds counted as income)** gets
  noticeably more irritating once the money is real, and is the obvious next thing to fix.
