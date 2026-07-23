# Plaid Production — Design Spec

- **Repo:** `smilne3/every-dollar-counts`
- **Date:** 2026-07-14 · **Revised 2026-07-23** (Plaid account went live; plan pressure-tested before any real bank was linked)
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
leaves two ways in, and we've chosen the first.

**Decision: the Trial plan.** *(Submitted 2026-07-16; **approved and live as of 2026-07-23**.)*

The Trial terms are confirmed against Plaid's own billing page rather than inferred: *"You can create
10 Production Items on a Trial plan"* and *"Removing Items created on a Trial plan (using
/item/remove) will not allow you to create more Items."* Also confirmed there: **Liabilities is
included free on Trial** (the full list is Assets, Auth, Balance, Identity, Investments, Liabilities,
Transactions, Statements), and *"if you added a subscription fee product … during your trial, upon
upgrading to a paid plan, you will begin to be charged."* Free now; not free forever if we ever
upgrade.

The Trial plan is free, gives real production bank data, includes the OAuth banks we need (Chase,
Bank of America, Wells Fargo, Capital One, Citi), and requires no security questionnaire, no MSA
addendum, and no SSN — Plaid collects only a few project details and most accounts go live
instantly. Its one constraint: **10 Items** (one Item = one bank login), and `/item/remove` does not
give a slot back.

**Why this reverses the earlier Pay-as-you-go call.** We first chose full Production/Pay-as-you-go,
reasoning that real money deserved the "real" tier and the paperwork was a fair price for freedom
from the 10-Item cap. Two things changed that once we saw the actual flow:

1. **The decision is asymmetric.** Trial → Production is a door we can walk through *later*, the day
   we actually hit the cap. Production is a door we can't walk back (applying forecloses Trial).
   Starting on Trial preserves both options; committing to Production destroys one. Given genuine
   uncertainty about future needs, take the path that keeps options open.
2. **Realistic usage fits inside 10.** A two-person household is ~4–6 logins, linked once and kept.
   The earlier worry — "freedom to link and unlink freely" — only bites if we *churn* through more
   than 10 lifetime links, which a stable household won't. That advantage was theoretical; it was
   weighted over actual behavior.

Bonus: the Production flow was asking for an **SSN and date of birth**. For a personal hobby app,
skipping that (Trial doesn't require it) is a real privacy win. And the cost: Trial is free where
Pay-as-you-go was a small-but-perpetual monthly charge — YAGNI.

**The counter-case we accepted the risk on:** if usage turns out to involve experimenting with many
institutions (linking and dropping lots of different banks), the 10-Item no-refund cap bites and
we'd upgrade to Production anyway. Judged unlikely for this household.

To set up, in order:

1. Submit the Trial application (a few project details; no questionnaire, no SSN). **Done
   2026-07-16 — approved 2026-07-23.**
2. Copy the **production secret**. **Outstanding.**
   *Corrected 2026-07-23 (verified in the dashboard and in Plaid's glossary):* there is **one
   `client_id` for the whole team** — *"the same for all API calls made on behalf of your
   organization, regardless of the API environment."* Only the **secret** differs per environment,
   and the Keys page lists "Production secret" and "Sandbox secret" separately. So
   `PLAID_CLIENT_ID` does **not** change at cutover; `PLAID_SECRET` is the only key that does.
3. Register the OAuth redirect URI: `https://every-dollar-counts.vercel.app/plaid/oauth`.
   **Outstanding — this is a hard gate, not a nicety.** Until it is registered, the big OAuth banks
   (Chase, BofA, Wells Fargo, Capital One, Citi) will not open at all.
4. Set the app display name so the bank's consent screen says "Every Dollar Counts." **Outstanding.**

### Slot budget

Ten Items, lifetime, no refunds. Planned spend, assuming checking and credit cards at the same
institution share one login:

| Link | Slots |
| --- | --- |
| Primary bank (checking/savings + any cards or mortgage held there) | 1 |
| Each additional card issuer at its own institution | 1 each |
| Brokerage | 1 |
| Each standalone loan servicer (no checking account there) | 1 each |
| Partner's bank, if separate | 1 |

Realistic intended spend is 5–7, leaving 3–5 in reserve. **The reserve is not spare capacity — it is
the budget for mistakes**, and §11 exists to make sure mistakes happen in sandbox instead. A failed
link still spends a slot: the Item is created at Plaid the moment Plaid Link finishes, before this
app has stored anything.

**Item slots are scarce and unrefundable (10, no give-back), so §11 proves every flow in sandbox
before spending a single one.** If we ever hit the cap, upgrade to Production then — see
`docs/plaid-production-application.md`, which holds the (now-deferred) security-questionnaire draft
for exactly that day.

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
- `/plaid/oauth` must be **exempt from the login gate**. `proxy.ts` treats only `/login` and `/auth`
  as public, so a bank returning the user to `/plaid/oauth` after a session lapse — entirely normal
  when the bank's own login takes several minutes of MFA — gets bounced to the login page and the
  half-finished connection is lost. The Item still exists at Plaid. The slot is still spent. The
  exemption is safe: the page renders no household data, and every route it calls does its own
  authentication check.
- The saved link context needs an **expiry**. Plaid link tokens last 4 hours for a new bank and only
  **30 minutes** in update mode. Nothing currently timestamps the saved context or clears it when the
  user backs out, so a stale entry sits in the browser waiting to be fed to Link later.

### A failed link must be loud

This is the single most expensive defect in the original plan, so it gets stated as a design rule.

**The Plaid connection is created the moment Link finishes** — before this app has stored anything.
Everything after that (exchanging the token, encrypting it, writing the row) can fail, and in the
original design every one of those failures looked exactly like success: the widget closes, the page
refreshes, no bank appears, no error is shown. The natural human response is to click "Connect a
bank" again, which creates a *second* Item and spends a *second* unrefundable slot — while the first
connection stays live at the real bank with no local record and therefore no way to revoke it.

So: every step of the link flow surfaces its outcome. If the exchange fails, say so and keep the
pending context so a retry actually retries (public tokens stay valid ~30 minutes) instead of
starting a fresh connection. If the exchange can't be stored, tear the Item down at Plaid rather than
abandoning it. If Link is cancelled or errors, clear the pending context and say what happened — no
spinner that never resolves. And Settings shows **"Bank connections used: N of 10"** so the budget is
visible rather than remembered.

## 5. Code change 2 — three kinds of "add account"

Plaid Link only shows institutions that support **every** product in the request. Today the link
token asks for `transactions` alone, which means a pure brokerage (Vanguard, Schwab) never appears
in the list. Adding `investments` to the same request would shrink it the other way and start
hiding ordinary banks.

So one button becomes three paths:

| What you're adding | Products requested | What we ingest |
| --- | --- | --- |
| Bank or credit card | `transactions` | Balances + transactions |
| Investment account | `investments` | **Balances only** |
| Loan or mortgage at its own servicer | `liabilities` | **Balances only** |

**Balances only is deliberate.** The brokerage's total value flows into net worth (which already
counts it) and nothing else. We do not ingest holdings or trades — that's a portfolio tracker, and
this is a budget tracker. Loans are the same story in reverse: the balance owed pulls net worth
*down*, and `lib/dashboard.ts` already treats a `loan` account as a liability, so no math changes.

**Why loans need a third path at all.** Plaid's Transactions product covers loan accounts only where
the subtype is `student` or `mortgage`. That means a mortgage held *at the same bank as the checking
account* should already appear in the existing "Connect a bank" flow, cost no extra code, and cost no
extra Item slot — tick it in the same Link session. A standalone servicer (Rocket, Mr. Cooper,
Nelnet) has no checking account, so under `products: ['transactions']` Link filters that institution
out of the list entirely. The `liabilities` product is the key to that door. We do **not** want
Liabilities' data (rates, payment schedules) — `/accounts/get` already returns the balance, which is
all net worth needs. **Auto loans and HELOCs are very likely not connectable at all**: both
Transactions and Liabilities restrict loan support to `student` and `mortgage`. That's an inference
from two docs, not a statement Plaid makes outright.

**Decide the products at link time — you cannot add them later.** This Plaid team is new enough to be
auto-enrolled in Data Transparency Messaging, under which products not consented to during Link
can't be accessed without sending the user back through update mode.

Schema: `plaid_items` gets a `products text[]` column recording which path created it.

### How much history to ask for — a one-time, irreversible choice

Plaid requests **90 days by default**, and the window must be set as `transactions.days_requested` on
the link-token call. Their docs are blunt about the consequences: *"The maximum amount of transaction
history to request on an Item cannot be updated if Transactions has already been added to the Item.
To request older transaction history on an Item where Transactions has already been added, you must
delete the Item via `/item/remove` and send the user through Link to create a new Item."*

On the Trial plan, "create a new Item" means **spending another unrefundable slot**. The dashboard
charts six months, so the default would leave half of every chart permanently blank.

**Decision: request 730 days on every transactions link.** It is one line, it costs nothing, and it
is the single least reversible parameter in this whole migration.

## 6. Code change 3 — sync respects the products column

`sync-transactions` currently loops every item and calls `/transactions/sync` on all of them. It must:

- Refresh balances for **every** item (`storeAccounts` — this is what makes brokerage and loan net
  worth work).
- Call `/transactions/sync` **only** for items whose `products` include `transactions`.
- Skip items marked `needs_reconnect` (§7) rather than hammering a connection that's known broken.
- **Never let one bank's failure end the loop.** Any error on one item is recorded against that item
  and the loop continues to the next. See §7.

`exchange-public-token` has the same problem — it unconditionally calls `syncAndStore` right after
linking — and gets the same fix.

*Correction to an earlier assumption:* the first draft said calling `/transactions/sync` on a
brokerage or loan item **errors**. It doesn't — Plaid returns empty arrays and quietly *adds* the
Transactions product to that Item. The guard is still right, but the reason is different: it avoids
attaching a subscription-billed product to an Item that will never use it. This matters for how we
verify the guard works — see §11.

## 7. Code change 4 — reconnect when a bank kicks you out

Real connections break: password changes, new MFA prompts, expiring bank consent. Today the app
handles this by doing nothing visible — sync stops returning transactions and no one finds out
until they notice the numbers went stale. On real money that's the worst possible failure.

- `plaid_items` gets `status` and `status_detail`. **Three states, not two:** `ok`,
  `needs_reconnect` (you must re-authenticate — update mode fixes it), and
  `temporarily_unavailable` (the bank is down or rate-limiting — wait, do nothing). Two states would
  tell Sarah to reconnect a bank that is merely offline, which wastes her time and risks a re-link.
- Sync catches **every** error per item, records the code in `status_detail`, and moves on to the
  next bank. Only the reconnect-fixable codes set `needs_reconnect`.
- **Which codes mean "reconnect" — corrected.** The first draft listed `ITEM_LOGIN_REQUIRED`,
  `PENDING_EXPIRATION` and `PENDING_DISCONNECT`. The last two are *webhook* codes, not API error
  codes: they never appear on a thrown API error, so two thirds of that list was dead code. The real
  set is `ITEM_LOGIN_REQUIRED`, `ACCESS_NOT_GRANTED`, `INVALID_UPDATED_USERNAME`,
  `MANUAL_VERIFICATION_REQUIRED`, `USER_PERMISSION_REVOKED`. Production also routinely throws
  `INSTITUTION_DOWN`, `INSTITUTION_NOT_RESPONDING`, `ITEM_LOCKED`, `PASSWORD_RESET_REQUIRED` and
  `RATE_LIMIT_EXCEEDED` — none of which sandbox produces, and none of which update mode fixes.
- The dashboard shows a broken bank plainly, with a **Reconnect** button.
- **Refresh has to report what happened.** Today the button throws its own response away, so a
  failure is indistinguishable from success. It must say "Updated 4 banks, 12 new transactions" or
  "2 banks couldn't update." Silent staleness is the exact failure this section exists to prevent;
  a Refresh button that swallows errors just relocates it.
- Reconnect creates a link token in **update mode** (the item's `access_token`, no products) and
  reopens Link. On success the status clears and syncing resumes — **no new Item is consumed.**

## 8. Code change 5 — disconnect a bank (closes #11)

Currently there's no way to remove a bank, which matters more when the credential is real.

- New route: call Plaid's `/item/remove`, then delete the item.
- **Never delete a row we could not remove at Plaid.** The encrypted access token is the *only* way
  to revoke a connection. If decryption fails, or Plaid returns an error, and we delete the row
  anyway, then Plaid keeps a live connection to the household's real bank login that this app can
  never revoke — while the UI claims it's disconnected and the slot is spent. Swallow only "it's
  already gone there" (`ITEM_NOT_FOUND`, `INVALID_ACCESS_TOKEN`); on anything else, keep the row and
  surface the error so it can be retried.
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

**A confirmation flag is not a sufficient guard, because there is only one database.** The same
Supabase project serves the laptop, previews, and the live site, so the exact command that clears
fake data before go-live is just as destructive the day *after* go-live — and the script deletes
`plaid_items` rows without calling `/item/remove`, meaning every real bank would stay connected at
Plaid with the token needed to revoke it gone forever. Three changes make it safe:

1. **Tag rows by environment.** `plaid_items` gets `plaid_env text not null default 'sandbox'`,
   stamped at link time. The script deletes only `plaid_env = 'sandbox'`. The app filters on it too,
   which independently fixes a real crash — see §10.
2. **Back up first.** A manual Supabase backup (or CSV export of `plaid_items`, `accounts`,
   `transactions`) before anything destructive. There is no down-migration and no second
   environment; this is the only rollback that exists.
3. **Delete the script after cutover.** It has one job and one day to do it.

## 10. Environments and secrets

| Where | `PLAID_ENV` | Database | Why |
| --- | --- | --- | --- |
| Local dev | `sandbox` | **the same one** | Can't burn an Item slot or touch a real bank by accident |
| Vercel preview | `sandbox` | **the same one** | Same |
| Vercel production | `production` | **the same one** | The only place real banks are linked |

Production Plaid keys are set on Vercel production **only**. `TOKEN_ENCRYPTION_KEY` is ours, not
Plaid's, and does not change. `PLAID_REDIRECT_URI` is new and differs per environment.

**The "Database" column is the trap.** The original table varied only `PLAID_ENV`, which hid the fact
that all three environments write to one Supabase project. After cutover, an ordinary `npm run dev`
writes *sandbox* banks into the *production* table. The live site's Refresh then loops that row,
calls production Plaid with a sandbox token, gets `INVALID_ACCESS_TOKEN` — which is not a reconnect
error — and, in the original design, rethrows and takes **every real bank's sync down with it** until
someone finds and deletes the stray row.

**Decision: tag rows by environment** (`plaid_items.plaid_env`, per §9) and filter every read on it,
rather than standing up a second Supabase project. It fixes the crash, shrinks the reset script's
blast radius, costs one column, and adds no new account to keep in sync. Two consequences accepted
deliberately: local dev and preview deployments hold service-role access and the decryption key for
real bank tokens, and `TOKEN_ENCRYPTION_KEY` must be backed up to the password vault **before**
go-live — losing it is indistinguishable from a security incident and equally unrecoverable.

Two further env-var gotchas that would each have burned a slot on cutover day:

- **`PLAID_ENV` fails silently.** `lib/plaid.ts` tests for the exact string `'production'`; anything
  else — unset, `Production`, a trailing space — quietly selects sandbox. Paired with production
  credentials that yields an authentication error the UI never shows. It should refuse to start
  unless the value is exactly `sandbox` or `production`.
- **Setting a variable on Vercel does nothing until you redeploy.** Vercel's docs: *"Changes to
  environment variables are not applied to previous deployments… You must redeploy your project."*
  Without an explicit redeploy step, the "link one real bank" step runs against the sandbox build —
  fake bank list, and real credentials typed into a sandbox session.

This falls out of the OAuth requirement anyway: the redirect must be a registered HTTPS URL, so
real bank linking happens on the live site, not on localhost.

## 11. How we verify

Everything is proven in sandbox before a real credential or a real Item slot is spent. Approval has
now landed, which changes **nothing** about this order: the reason to rehearse was never that Plaid
hadn't approved us — it's that slots don't come back.

0. **Free pre-checks, before writing any code.** Search Plaid's institution list for each loan
   servicer with `products: ["liabilities"]` (via the Dashboard's coverage explorer or
   `/institutions/search` on the sandbox keys) to learn whether it's supported at all. Costs nothing,
   spends no slot, and may delete the whole third link path from the plan.
1. **Sandbox, OAuth test bank.** Plaid's sandbox includes an OAuth institution. Exercise the full
   redirect round-trip there and confirm a bank links end to end.
2. **Sandbox, the rest.** Reconnect (Plaid can force an item into `ITEM_LOGIN_REQUIRED` on demand)
   and disconnect, including confirming the transactions actually leave the table. Also rehearse the
   **failure** paths, since those are what spend slots: cancel out of Link midway, and force the
   exchange to fail, and confirm both produce a visible error rather than a silent no-op.
   For the balances-only paths, prove the guard actually fired — assert the item's `cursor` column is
   still `NULL`. "No transactions appeared" proves nothing, because a brokerage has none anyway.
3. **Prove the live site is really on production Plaid — before spending a slot.** After redeploying,
   open the live site, click Connect a bank, and search "Chase." A real Chase logo means production;
   "First Platypus Bank" means the deploy didn't take. Close Link without finishing. This costs
   nothing and catches the single most likely cutover mistake.
4. **Production data, one real bank.** Link it. *(Spends 1 of 10 slots — deliberately, only after
   0–3 pass.)* **Balances appear immediately; transactions do not.** Plaid's first pull runs for
   minutes to hours, so an empty transaction list right after linking is normal, not broken. Wait and
   press Refresh again. Do **not** re-link — that is the mistake this note exists to prevent.
5. **Production data, the rest.** Brokerage, credit cards, loans. Confirm net worth against a number
   already known to be true.
6. **Check the numbers are right, not just present.** Sandbox never stressed this:
   - Adding a credit card should make net worth go **down**, not up.
   - If a mortgage lands in the same login as checking, the monthly payment arrives **twice** — once
     leaving checking, once arriving at the loan — and `monthlyFlows` filters by category, never by
     account type. Spending would be inflated by one mortgage payment a month.
   - Watch bug **#8** (refunds counted as income). With real cards, every refund and statement credit
     is a negative amount with a shopping category, so it lands in Income. Harmless in sandbox;
     inflating monthly income within days of go-live.
   - Confirm a closed account actually disappears. `storeAccounts` only ever upserts — nothing
     deletes an `accounts` row — so an account that vanishes at the bank keeps its last balance and
     goes on counting toward net worth forever.

## 12. Explicitly out of scope

- **Nightly cron** (#15) — Refresh stays a button you press.
- **Holdings and trades** — balances only, per §5.
- **Liabilities *data*** (interest rates, payment schedules). We request the product only to make
  loan-only institutions selectable in Link; we ingest balances.
- The existing known bugs stay open, with one loud exception: **#8 (refunds counted as income)**
  starts corrupting real numbers within days of go-live, and is the obvious next thing to fix.

**Pulled back *into* scope: webhooks (#14).** Originally deferred as a nice-to-have. Two things
changed that judgment:

1. Plaid is force-migrating Bank of America Items to a new API through late 2026. The warning arrives
   as a `PENDING_DISCONNECT` webhook with a **one-week** window before the connection drops into
   `ITEM_LOGIN_REQUIRED`. Without a webhook receiver there is no warning at all — and, per §7, those
   codes never appear as API errors, so nothing else can surface them.
2. It's the fix for "the first link looks empty." Plaid fires `INITIAL_UPDATE` and
   `HISTORICAL_UPDATE` when the transaction pull finishes; with no cron and no webhooks, the only way
   to find out is to press Refresh and hope.

It is one route that flips a status column — much smaller than it sounds, and the alternative is
finding out a bank broke by noticing the numbers went stale, which is the failure this whole spec
exists to eliminate.
