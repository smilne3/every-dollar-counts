# Every Dollar Counts — Design Spec

- **Repo:** `smilne3/every-dollar-counts`
- **Date:** 2026-07-10
- **Status:** Approved design, ready for implementation plan
- **One line:** A simple, Mint-style household budget tracker for two people, with secure automatic bank syncing.

---

## 1. Purpose

Recreate the part of the old Mint app that mattered day to day: see all your money in one
place, watch where it goes, and stay on budget — for a two-person household — without the
bloat. It must connect to real bank accounts **safely** and require a real login.

**Success looks like:** Sarah and her partner log in from any device, see their connected
accounts and balances, watch spending sort itself into categories, set budgets, and track a
savings goal — with the confidence that no one else can see their data and the app can never
move their money.

## 2. Users & scope

- **Who logs in:** two people (Sarah + partner) sharing **one household budget**. Both see and
  edit the same accounts, budgets, and goals.
- **Where it runs:** a hosted web app, reachable securely from phone and laptop over HTTPS.
- **How bank data arrives:** automatically, via Plaid (the same style of secure connector Mint
  used). No manual entry, no file imports.

## 3. Version 1 features

The lean core people actually used weekly, plus savings goals:

1. **Dashboard** — every connected account and its balance in one place, plus a household total.
2. **Transactions** — pulled in automatically, auto-categorized, searchable; tap any transaction
   to re-file its category, and the choice sticks.
3. **Budgets** — set a monthly limit per category; simple progress bars show how close you are.
4. **Trends** — two clean charts: spending by category this month, and this month vs. last.
5. **Savings goals** — set a target (e.g., "$3,000 emergency fund") and track progress toward it.
6. **Settings** — connect/disconnect a bank; invite your partner to the household.

## 4. Non-goals (explicitly out for v1)

Kept out to stay simple and secure. Can be revisited later.

- Credit score tracking
- Investment / portfolio tracking
- Bill negotiation or bill-pay
- Moving money / any write access to bank accounts
- Over-budget email alerts and recurring-subscription detection *(nice-to-haves deferred; not in v1)*
- More than one household, or public sign-up (invite-only, just the two of them)

## 5. Architecture (plain)

Four pieces, each with one job:

```
   You & partner            The app                 Your data              Your banks
   (phone / laptop)   →   (Next.js on Vercel)  →   (Supabase)        ⇄   (via Plaid)
                            the screens             login + database       secure bank feed
```

- **Vercel** — hosts and serves the app over HTTPS to any device.
- **Next.js** — the app itself (the screens and the small amount of server code that talks to
  Plaid). Chosen because it's a familiar, well-supported stack.
- **Supabase** — handles login (authentication) and stores the data (accounts, transactions,
  budgets, goals) in a Postgres database.
- **Plaid** — the only component that ever touches a bank. The user enters their bank password on
  **Plaid's** screen, never ours. Plaid returns a token that lets the app **read** transactions
  and balances. The app has **no ability to move money**.

**Why this stack:** Supabase gives real login and row-level security (see §7) almost for free,
which is exactly what "safe household sharing" needs; Plaid keeps bank credentials out of our
app entirely; Vercel makes it reachable anywhere. It's also a stack Sarah has worked in before.

**Alternatives considered and rejected:** a no-code builder (too risky for bank data + custom
auth); a local-only desktop app (fails the "reachable anywhere" requirement).

## 6. Data model (plain)

```
household ─┬─ members        (Sarah, partner — the people who can log in)
           ├─ bank_connections  (one per linked bank, holds the Plaid token — server-side only)
           │     └─ accounts     (checking, savings, credit card…)
           │           └─ transactions  (date, amount, merchant, category)
           ├─ budgets         (one monthly limit per category)
           └─ savings_goals   (name, target amount, current progress)
```

- Every row belongs to exactly one **household**.
- Categories are a small fixed list to start (Groceries, Dining, Utilities, etc.), with the
  ability to re-file a transaction into a different category.

## 7. Security model (the part that matters most)

- **Bank password never touches our app.** Plaid collects it on Plaid's own screen. We only ever
  receive a read-only token.
- **Plaid tokens live server-side only,** encrypted at rest, never sent to the browser.
- **Household isolation via row-level security (RLS):** database rules enforce that a member can
  read/write **only** their own household's rows. This is enforced at the database, not just hidden
  in the UI — so even a bug elsewhere cannot leak one household's data to another user.
- **All traffic over HTTPS;** secrets (Plaid keys, Supabase service key) live in Vercel's
  encrypted environment vault, never in the code or the repo.
- **Read-only bank access** — by design the app cannot spend or transfer money.
- **Invite-only** — no open public sign-up; only invited household members can create an account.

## 8. Authentication & authorization

- **Authentication (who you are):** email + password or magic email link, via Supabase Auth.
- **Authorization (what you can see/do):**
  - The first user creates the household and invites the second by email.
  - Both members have equal access to the shared household data.
  - Anyone not in the household sees nothing — enforced by RLS (§7).

## 9. Cost & Plaid path

- **Build & test entirely on free tiers** using **Plaid Sandbox** (realistic *fake* banks —
  free, unlimited). Vercel, Supabase, and Plaid Sandbox all fit inside free tiers for a
  two-person app, so there is **no spend to get a fully working app.**
- **Going live with real banks** is a later switch: apply for Plaid production access (short
  approval), then swap the Plaid keys from sandbox to production. Real bank connections may cost
  roughly a few dollars per month past Plaid's free allowance. Decision deferred until the app is
  working and Sarah decides it's worth it.

## 10. Build phases

Each phase ends in something testable; we don't advance until the current phase actually works.

1. **Skeleton + login.** App deploys and runs; a user can sign up/log in; a household is created.
   *Test:* two accounts can log in; a stranger cannot; RLS blocks cross-household reads.
2. **Connect a bank (Sandbox) + Dashboard + Transactions.** Link a Plaid Sandbox bank; accounts
   and transactions appear and auto-categorize; re-filing a category sticks.
   *Test:* fake accounts/transactions render; recategorization persists; token is server-side only.
3. **Budgets + Trends.** Per-category monthly limits with progress bars; the two charts.
   *Test:* a budget shows correct spent-vs-limit; charts match the underlying transactions.
4. **Savings goals.** Create a goal, track progress.
   *Test:* progress reflects contributions/target correctly.
5. **Go-live checklist.** Security once-over (RLS, secrets, HTTPS, token handling), then flip
   Plaid from Sandbox to production for real banks.

## 11. Testing approach

- Testing rides along each phase (no big-bang test phase at the end).
- Emphasis on the security-critical paths: RLS household isolation, token never reaching the
  browser, invite-only access.
- Plaid Sandbox provides deterministic fake data to test the sync/categorize flow repeatably.

## 12. Open questions (to resolve during planning)

- Exact starting category list (can use Plaid's default categories, lightly grouped).
- Login method preference: password vs. magic email link (default: magic link, simplest & secure).
- Budget period: calendar month to start (assumed), configurable later if needed.
