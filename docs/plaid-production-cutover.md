# Going live on real bank data — cutover runbook

Do these in order. Steps 0–8 are reversible; step 9 onward spends unrefundable bank connections.

**The one rule for the whole day:** if a bank doesn't appear after you connect it, **STOP**. Do not
click Connect again. Check Settings first — if it's listed there, it worked. Every fresh attempt
spends one of your ten bank connections permanently, and they are never refunded.

**A standing rule for after go-live: never link a bank from a local (`npm run dev`) or Vercel
Preview session against the live database.** Those run on `PLAID_ENV=sandbox`, and a sandbox bank
linked there would write fake accounts into the same database production reads — inflating your net
worth with invented balances that you can't disconnect from the production Settings page. The sync,
Settings, and webhook paths ignore mismatched-environment banks, but the net-worth/spending math
does not yet. If you ever need to test against sandbox again, do it against a throwaway Supabase
project, not this one.

---

### Before you touch anything

0. **Export the three Plaid tables.** Free plan has no automatic backups, so do this by hand:
   Supabase → Table Editor → export `plaid_items`, `accounts`, and `transactions` to CSV, save to
   Drive. These are the only tables the cutover changes. (Your categories, budgets, and goals are in
   other tables and are never touched — no need to export them.)
1. **Back up the encryption key.** Copy `TOKEN_ENCRYPTION_KEY` from Vercel into the password vault
   and confirm it matches. Losing it is unrecoverable and looks exactly like a security incident.

### Plaid dashboard — mostly done already

2. Confirm, in the Plaid dashboard:
   - Redirect URI `https://every-dollar-counts.vercel.app/plaid/oauth` is registered. ✅ *(done 2026-07-23)*
   - App display name is "Every Dollar Counts". ✅ *(done 2026-07-23)*
   - You have the **Production secret** copied and ready to paste. There is only **one client_id**
     for the whole team — it does not change; only the secret differs by environment.
   - Register the webhook URL `https://every-dollar-counts.vercel.app/api/plaid/webhook?key=<secret>`
     under Developers → Webhooks, where `<secret>` is the value you set as `PLAID_WEBHOOK_SECRET`.

### Ship and migrate

3. **Ship the code.** Merge `feature/plaid-production` to `main` (Vercel auto-deploys).
4. **Confirm the migration is applied.** `db/migrations/010_plaid_production.sql` was applied
   2026-07-23; verify the four columns and the `transactions_account_id_fkey` constraint still exist
   (query in the plan's Task 1). Nothing to run if they're there.
5. **Purge the sandbox data.**
   `node --env-file=.env.local scripts/reset-plaid-data.mjs --confirm`
   It deletes only rows tagged `plaid_env='sandbox'` and reports how many production rows it left
   alone (should be 0 at this point). Keeps categories, budgets, and goals.

### Flip to production

6. **Set production env on Vercel (Production scope only):**
   - `PLAID_ENV=production` — spelled exactly that, lowercase. Any other value refuses to start.
   - `PLAID_SECRET` = the **Production secret**. **Leave `PLAID_CLIENT_ID` alone** — it's the same
     in every environment and the value in Vercel is already correct.
   - `PLAID_REDIRECT_URI=https://every-dollar-counts.vercel.app/plaid/oauth`
   - `PLAID_WEBHOOK_URL=https://every-dollar-counts.vercel.app/api/plaid/webhook?key=<secret>`
   - `PLAID_WEBHOOK_SECRET=<the same long random string>`
   - Leave `TOKEN_ENCRYPTION_KEY` unchanged.
   - Confirm **Preview** and **Development** still hold `PLAID_ENV=sandbox` and the sandbox secret,
     so a preview deploy can never reach production Plaid.
7. **REDEPLOY. This step is not optional and is easy to miss.**
   Vercel → Deployments → the top production deployment → ⋯ → **Redeploy** (uncheck "use existing
   build cache"). Wait for **Ready**.
   *Environment variables do not apply to deployments that already exist.* Without this the live site
   is still the sandbox build, and step 9 would show you fake banks — or send real bank credentials
   into a sandbox session.
8. **Prove it's really production — costs nothing.** Open the live site, click **Connect a bank**,
   and search "Chase" or "Wells Fargo". A real logo means production. If everything still looks like
   sandbox, go back to step 7. **Close Link without finishing.**
   *(Note: Plaid's sandbox now shows real bank logos too — the only reliable tell in sandbox is the
   grey "Sandbox mode" banner. In production there is no banner.)*

### Link real banks

9. **Link Wells Fargo first.** It's an OAuth bank, so it hands you off to wellsfargo.com and back.
   Tick every account you want — including the mortgage, which comes in on this same login at no
   extra connection. Confirm the balances match what the bank's own website says.
   **Transactions will not appear right away.** Plaid's first pull runs for minutes to hours; an
   empty transaction list at this point is normal, not broken. Wait, then press **Refresh** again.
   Do **not** re-link.
10. **Link the rest** — any other bank, credit cards, brokerage (balances only).
11. **Check the numbers, not just their presence:**
    - Adding a credit card should make net worth go **down**.
    - If the mortgage came in alongside checking, glance at whether the monthly payment is being
      counted twice (once leaving checking, once arriving at the loan). Did not reproduce in sandbox,
      but Plaid's loan coverage varies by institution.
    - Watch for refunds landing in **Income** (bug #8) — with real cards this starts within days and
      is the first thing worth fixing after cutover.
    - Confirm net worth against a number you already know to be true.

---

## If it goes wrong

- **A bank didn't appear.** Check Settings. If it's listed, it worked. If not, check the Vercel
  runtime logs for `[plaid]` before retrying — the connection may exist at Plaid even though the app
  never stored it.
- **Nothing syncs at all.** Almost always step 7 — the redeploy. Confirm the live site shows real
  banks.
- **You need to back out entirely.** Set `PLAID_ENV=sandbox`, redeploy, delete the production rows by
  hand in the Supabase table editor, then re-import the step-0 CSVs if needed. **Be clear-eyed: any
  real bank already linked has spent its connection, and rolling back does not return it.**

Trial plan: 10 linked banks, lifetime, unrefundable. Upgrading to full Production later is documented
in `docs/plaid-production-application.md`.
