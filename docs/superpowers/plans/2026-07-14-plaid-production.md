# Plaid Production Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> ## Revised 2026-07-23 — read this before starting
>
> The Plaid Trial plan was **approved and is live**. That removed the gate that was quietly making
> this plan safe: mistakes used to be free. They now cost unrefundable Item slots (10, lifetime) and
> touch real bank credentials. The plan was reviewed against the actual codebase, live Plaid docs,
> and the installed Next.js 16 before any real bank was linked. What changed:
>
> - **Task 1** adds a `plaid_env` column. Sandbox and production rows share one database and are
>   otherwise indistinguishable; without it, one stray dev-linked bank breaks every real bank's sync.
> - **Task 2's** reconnect codes were wrong — two of the three were *webhook* codes that never appear
>   as API errors.
> - **Task 3** must set `transactions.days_requested`. Plaid's history window cannot be changed after
>   an Item exists except by re-linking, which spends a slot. This is the least reversible line in
>   the plan.
> - **Task 5** as written does not compile, does not lint, and its OAuth page is blocked by the login
>   gate. It also treated a failed link as a success, which is the defect most likely to burn slots.
> - **Task 6** let one sick bank abort every other bank's refresh — the exact failure the spec set out
>   to prevent.
> - **Task 7's** disconnect deleted the local row even when removal at Plaid failed, orphaning a live
>   connection to a real bank with no way to revoke it.
> - **Task 9's** runbook never redeployed after setting env vars (so the "link a real bank" step would
>   have run against the sandbox build), had no backup, and contained a dry-run instruction that is
>   impossible to follow safely.
> - **New Task 10:** webhooks, pulled back into scope.
> - **Loans/mortgages** are new scope, folded into Tasks 3–5.
>
> Full reasoning lives in the spec. Do not "simplify" these back out.

**Goal:** Take the app from Plaid's sandbox to real bank data — build the OAuth redirect and the reconnect/disconnect flows that sandbox never forced us to build, add balances-only brokerage support, and cut cleanly over from fake data.

**Architecture:** Token encryption and RLS already exist and don't change. The `PLAID_ENV` switch exists but gains a fail-fast guard (Task 1). This plan adds: a DB migration (link status, product tracking, environment tagging, cascade cleanup), two tested pure helpers, changes to the three existing Plaid routes plus `proxy.ts` and `RefreshButton`, three new routes (reconnect, remove-item, webhook), an OAuth completion page, and small UI for reconnect/disconnect. Testable logic is pure functions with unit tests; routes, pages, and scripts follow the repo's existing convention (no route/component tests) and are verified by build + typecheck + manual sandbox exercise — **including deliberate failure-path rehearsals, which are what protect unrefundable Item slots.**

**Tech Stack:** Next.js 16 (App Router) · TypeScript · Tailwind v4 · Supabase (Postgres + RLS) · Plaid (`plaid` + `react-plaid-link`) · Vitest.

**Spec:** `docs/superpowers/specs/2026-07-14-plaid-production-design.md`

## Global Constraints

- **This is Next.js 16, not the version you know.** Before writing any route or page, read the relevant guide in `node_modules/next/dist/docs/`. Route handlers are `app/api/**/route.ts` exporting `async function POST(req: Request)`; pages are `async` Server Components. (Per `AGENTS.md`.)
- **Never prefix a secret with `NEXT_PUBLIC_`.** `npm run check:secrets` fails the build if you do. Server-only modules start with `import 'server-only'`.
- **The Plaid access token never reaches the browser.** It lives in `plaid_items`, a table with RLS enabled and *no client policy*. Read it only via `supabaseAdmin` (service_role) in server code. When listing banks for the UI, select only safe columns — never `access_token_encrypted`.
- **Path alias is `@/`.** Client components start with `'use client'`.
- **Commands:** test `npx vitest run` · typecheck `npx tsc --noEmit` · lint `npm run lint` · build `npm run build` · secret guard `npm run check:secrets`.
- **Commit after every task** with a conventional-commit message. Branch: `feature/plaid-production`.
- **Money/label copy** stays plain-language and consistent with the existing UI (see `components/*` and the spec).

---

## File map

**Create:**
- `db/migrations/010_plaid_production.sql` — status/products columns + transactions→accounts cascade
- `lib/plaid-errors.ts` — detect Plaid "needs reconnect" errors (pure, tested)
- `lib/sync-policy.ts` — decide whether an item should sync transactions (pure, tested)
- `lib/plaid-items.ts` — server-only helper listing banks for a household (safe columns only)
- `components/plaid-link-context.ts` — client localStorage contract for surviving the OAuth redirect
- `components/ReconnectButton.tsx` — reopens Link in update mode
- `components/BankList.tsx` — per-bank list with reconnect/disconnect
- `app/plaid/oauth/page.tsx` — OAuth return page
- `app/api/plaid/reconnect/route.ts` — clear needs-reconnect + resync one item
- `app/api/plaid/remove-item/route.ts` — remove a bank at Plaid and locally
- `app/api/plaid/webhook/route.ts` — **(Task 10)** receive Plaid item webhooks
- `scripts/reset-plaid-data.mjs` — guarded sandbox→production data purge
- `docs/plaid-production-cutover.md` — go-live runbook
- `tests/unit/plaid-errors.test.ts`, `tests/unit/sync-policy.test.ts`

**Modify:**
- `app/api/plaid/create-link-token/route.ts` — add/update modes + `redirect_uri` + `days_requested`
- `app/api/plaid/exchange-public-token/route.ts` — store `products` + `plaid_env`, branch sync
- `app/api/plaid/sync-transactions/route.ts` — skip investment/broken items, mark broken, never abort
- `components/LinkButton.tsx` — three variants (bank / investment / loan), save link context
- `components/RefreshButton.tsx` — **report the outcome instead of discarding it**
- `proxy.ts` — **exempt `/plaid/oauth` from the login gate** (without this, OAuth returns are lost)
- `app/(app)/settings/page.tsx` — render `BankList` + "connections used: N of 10"
- `app/(app)/dashboard/page.tsx` — broken-bank banner
- `.env.example` — add `PLAID_REDIRECT_URI`

---

## Task 1: Schema migration — link status, products, cascade cleanup

**Files:**
- Create: `db/migrations/010_plaid_production.sql`
- Modify: `.env.example`

**Interfaces:**
- Produces: `plaid_items.status text` (`'ok'` | `'needs_reconnect'`), `plaid_items.status_detail text`, `plaid_items.products text[]`; a `transactions.account_id → accounts.account_id ON DELETE CASCADE` foreign key. Later tasks read/write these columns.

- [ ] **Step 1: Write the migration**

Create `db/migrations/010_plaid_production.sql`:

```sql
-- Phase 5: Plaid production — link status, product tracking, and cascade cleanup.

-- Per-item link health and which products it was linked with.
-- status: 'ok' | 'needs_reconnect' (re-auth required) | 'temporarily_unavailable' (bank down; wait)
alter table plaid_items
  add column if not exists status text not null default 'ok',
  add column if not exists status_detail text,
  add column if not exists products text[] not null default '{transactions}';

-- Which Plaid environment created this item. Local dev, preview, and production all share this one
-- database, and a sandbox access token is worthless against the production API — it fails with
-- INVALID_ACCESS_TOKEN, which is NOT a reconnect error. Without this column, one bank linked from a
-- laptop after go-live is indistinguishable from a real one and takes every real bank's sync down
-- with it. Every read filters on it; the reset script deletes only sandbox rows.
alter table plaid_items
  add column if not exists plaid_env text not null default 'sandbox';

-- Defensive: drop any transaction whose account no longer exists, so the FK below
-- can be added. None are expected today (no disconnect feature has existed), and this
-- makes the migration safe to apply regardless of whether the sandbox reset ran first.
delete from transactions
  where account_id not in (select account_id from accounts);

-- Deleting a bank (plaid_items) already cascades to its accounts (see 002). This carries
-- the cascade the rest of the way to transactions, so removing a bank can never leave
-- orphaned transactions silently counting toward spending.
alter table transactions
  drop constraint if exists transactions_account_id_fkey;
alter table transactions
  add constraint transactions_account_id_fkey
  foreign key (account_id) references accounts(account_id) on delete cascade;
```

- [ ] **Step 2: Add the new env var to `.env.example`**

In `.env.example`, add under the Plaid lines:

```
PLAID_REDIRECT_URI=   # e.g. http://localhost:3000/plaid/oauth (sandbox) or the https Vercel URL (prod); leave blank to skip OAuth
PLAID_WEBHOOK_URL=    # https://every-dollar-counts.vercel.app/api/plaid/webhook — must be a public https URL; leave blank locally
PLAID_WEBHOOK_SECRET= # long random string; must match the ?key= on the URL registered with Plaid
```

- [ ] **Step 2b: Make `PLAID_ENV` fail loudly instead of silently choosing sandbox**

In `lib/plaid.ts`, the environment test is an exact string match on `'production'` — so an unset
value, `Production`, `prod`, or a trailing space all quietly select **sandbox**. Paired with
production credentials that produces an authentication failure the UI never surfaces, and on a Vercel
typo there'd be no signal at all about why nothing works. Add a guard above the client:

```ts
const env = process.env.PLAID_ENV
if (env !== 'sandbox' && env !== 'production') {
  throw new Error(
    `PLAID_ENV must be exactly "sandbox" or "production" (got ${JSON.stringify(env)}). ` +
      'Refusing to start rather than silently falling back to sandbox.'
  )
}
```

Then use `env === 'production'` for the `basePath` choice.

- [ ] **Step 3: Apply the migration to the Supabase project and verify**

Apply `010_plaid_production.sql` in the Supabase SQL editor (or your migration runner), then run this check:

```sql
select column_name from information_schema.columns
  where table_name = 'plaid_items'
    and column_name in ('status','status_detail','products','plaid_env');
select constraint_name from information_schema.table_constraints
  where table_name = 'transactions' and constraint_name = 'transactions_account_id_fkey';
```

Expected: four column rows, and one constraint row.

> **If the FK step errors** with a foreign-key violation, orphaned transactions exist beyond what the defensive delete caught — re-run the `delete from transactions ...` statement, then the `alter table ... add constraint` statement. Do not weaken the FK.

- [ ] **Step 4: Commit**

```bash
git add db/migrations/010_plaid_production.sql .env.example
git commit -m "feat(db): add plaid item status/products and cascade transactions on account delete"
```

---

## Task 2: Pure helpers — reconnect-error detection and sync policy

**Files:**
- Create: `lib/plaid-errors.ts`, `lib/sync-policy.ts`
- Test: `tests/unit/plaid-errors.test.ts`, `tests/unit/sync-policy.test.ts`

**Interfaces:**
- Produces:
  - `plaidErrorCode(err: unknown): string | null`
  - `isReconnectError(err: unknown): boolean`
  - `shouldSyncTransactions(item: { products: string[] | null; status: string | null }): boolean`

- [ ] **Step 1: Write the failing test for `plaid-errors`**

Create `tests/unit/plaid-errors.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { plaidErrorCode, isReconnectError } from '@/lib/plaid-errors'

// Plaid's node SDK throws axios-shaped errors: err.response.data.error_code
function plaidError(code: string) {
  return { response: { data: { error_code: code } } }
}

describe('plaidErrorCode', () => {
  it('pulls the error_code from an axios-shaped Plaid error', () => {
    expect(plaidErrorCode(plaidError('ITEM_LOGIN_REQUIRED'))).toBe('ITEM_LOGIN_REQUIRED')
  })
  it('returns null for a plain Error or nullish input', () => {
    expect(plaidErrorCode(new Error('boom'))).toBeNull()
    expect(plaidErrorCode(null)).toBeNull()
  })
})

describe('isReconnectError', () => {
  it('is true for codes that Link update mode actually fixes', () => {
    expect(isReconnectError(plaidError('ITEM_LOGIN_REQUIRED'))).toBe(true)
    expect(isReconnectError(plaidError('USER_PERMISSION_REVOKED'))).toBe(true)
  })
  it('is false for unrelated Plaid errors and non-Plaid errors', () => {
    expect(isReconnectError(plaidError('INVALID_ACCESS_TOKEN'))).toBe(false)
    expect(isReconnectError(new Error('network'))).toBe(false)
  })
  // PENDING_EXPIRATION / PENDING_DISCONNECT are WEBHOOK codes, not API error codes. They never
  // arrive on a thrown request, so treating them as reconnect errors here is dead code.
  it('is false for webhook-only codes', () => {
    expect(isReconnectError(plaidError('PENDING_EXPIRATION'))).toBe(false)
    expect(isReconnectError(plaidError('PENDING_DISCONNECT'))).toBe(false)
  })
})

describe('isTemporaryError', () => {
  it('is true for bank-side outages and rate limits', () => {
    expect(isTemporaryError(plaidError('INSTITUTION_DOWN'))).toBe(true)
    expect(isTemporaryError(plaidError('RATE_LIMIT_EXCEEDED'))).toBe(true)
  })
  it('is false for a broken login, which needs the user not patience', () => {
    expect(isTemporaryError(plaidError('ITEM_LOGIN_REQUIRED'))).toBe(false)
  })
})
```

Update the import on the first line of the file to
`import { plaidErrorCode, isReconnectError, isTemporaryError } from '@/lib/plaid-errors'`.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/unit/plaid-errors.test.ts`
Expected: FAIL — cannot resolve `@/lib/plaid-errors`.

- [ ] **Step 3: Implement `lib/plaid-errors.ts`**

```ts
// Codes where the user must re-authenticate and Link's UPDATE MODE actually fixes it.
//
// NOTE: PENDING_EXPIRATION and PENDING_DISCONNECT are deliberately absent. They are ITEM *webhook*
// codes, not API error codes — they never appear on a thrown API error, so listing them here did
// nothing. They are handled by the webhook route (Task 10) instead.
const RECONNECT_CODES = new Set([
  'ITEM_LOGIN_REQUIRED',
  'ACCESS_NOT_GRANTED',
  'INVALID_UPDATED_USERNAME',
  'MANUAL_VERIFICATION_REQUIRED',
  'USER_PERMISSION_REVOKED',
])

// Codes that mean "not your fault, try later." Reconnecting does nothing for these, so the UI must
// not tell the user to reconnect. Sandbox essentially never produces them; production routinely does.
const TEMPORARY_CODES = new Set([
  'INSTITUTION_DOWN',
  'INSTITUTION_NOT_RESPONDING',
  'INSTITUTION_NOT_AVAILABLE',
  'RATE_LIMIT_EXCEEDED',
  'PRODUCT_NOT_READY',
  'INTERNAL_SERVER_ERROR',
])

// Plaid's node SDK throws axios errors carrying the API error body on err.response.data.
export function plaidErrorCode(err: unknown): string | null {
  const code = (err as { response?: { data?: { error_code?: unknown } } })?.response?.data
    ?.error_code
  return typeof code === 'string' ? code : null
}

export function isReconnectError(err: unknown): boolean {
  const code = plaidErrorCode(err)
  return code !== null && RECONNECT_CODES.has(code)
}

export function isTemporaryError(err: unknown): boolean {
  const code = plaidErrorCode(err)
  return code !== null && TEMPORARY_CODES.has(code)
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/unit/plaid-errors.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing test for `sync-policy`**

Create `tests/unit/sync-policy.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { shouldSyncTransactions } from '@/lib/sync-policy'

describe('shouldSyncTransactions', () => {
  it('syncs a healthy transactions item', () => {
    expect(shouldSyncTransactions({ products: ['transactions'], status: 'ok' })).toBe(true)
  })
  it('does not sync an investment-only item (balances only)', () => {
    expect(shouldSyncTransactions({ products: ['investments'], status: 'ok' })).toBe(false)
  })
  it('does not sync a loan-only item (balances only)', () => {
    expect(shouldSyncTransactions({ products: ['liabilities'], status: 'ok' })).toBe(false)
  })
  it('does not sync an item that needs reconnection', () => {
    expect(shouldSyncTransactions({ products: ['transactions'], status: 'needs_reconnect' })).toBe(
      false
    )
  })
  it('does not sync when products is null', () => {
    expect(shouldSyncTransactions({ products: null, status: 'ok' })).toBe(false)
  })
})
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run tests/unit/sync-policy.test.ts`
Expected: FAIL — cannot resolve `@/lib/sync-policy`.

- [ ] **Step 7: Implement `lib/sync-policy.ts`**

```ts
// Whether we should call transactions/sync for an item. Investment and loan items are
// balances-only; a broken item is skipped until reconnected.
//
// Why the guard exists: calling transactions/sync on such an item does NOT error (an earlier draft
// of this plan claimed it did). Plaid returns empty arrays and quietly ADDS the Transactions product
// to that Item — a subscription-billed product on an Item that will never use it, plus a pointless
// historical pull. Because it doesn't error, "no transactions appeared" does not prove the guard
// works; assert the item's `cursor` is still NULL instead.
export function shouldSyncTransactions(item: {
  products: string[] | null
  status: string | null
}): boolean {
  return (item.products ?? []).includes('transactions') && item.status !== 'needs_reconnect'
}
```

- [ ] **Step 8: Run it to verify it passes**

Run: `npx vitest run tests/unit/sync-policy.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add lib/plaid-errors.ts lib/sync-policy.ts tests/unit/plaid-errors.test.ts tests/unit/sync-policy.test.ts
git commit -m "feat: add pure helpers for plaid reconnect detection and sync policy"
```

---

## Task 3: Link-token route — add & update modes, OAuth redirect

**Files:**
- Modify: `app/api/plaid/create-link-token/route.ts`

**Interfaces:**
- Consumes: `plaidClient` (`@/lib/plaid`), `supabaseAdmin` (`@/lib/supabase/admin`), `decrypt` (`@/lib/crypto`), `createClient` (`@/lib/supabase/server`).
- Produces: `POST` accepting JSON body `{ mode?: 'add' | 'update', products?: string[], itemId?: string }`, returning `{ link_token }`. `add` (default) creates a token for new-bank linking with the given products; `update` creates an update-mode token for the given item (reconnect). Both include `redirect_uri` when `PLAID_REDIRECT_URI` is set.

- [ ] **Step 1: Read the Next.js 16 route-handler guide**

Skim `node_modules/next/dist/docs/` for the route handler / Request-body guidance. Confirm reading the JSON body is `await req.json()`.

- [ ] **Step 2: Replace the route with add/update handling**

Replace the entire contents of `app/api/plaid/create-link-token/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { CountryCode, Products } from 'plaid'
import { plaidClient } from '@/lib/plaid'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { decrypt } from '@/lib/crypto'

// Map the client's requested product strings to Plaid's enum. Only the three we support.
// Plaid Link only lists institutions supporting EVERY requested product, so these are deliberately
// separate paths rather than one combined request — asking for all three would show almost nothing.
function toProducts(input: unknown): Products[] {
  const list = Array.isArray(input) ? input : ['transactions']
  const out: Products[] = []
  if (list.includes('transactions')) out.push(Products.Transactions)
  if (list.includes('investments')) out.push(Products.Investments)
  // Liabilities is requested only as a key to the door: it's what makes loan-only institutions
  // (mortgage servicers, student-loan servicers) selectable in Link. We ingest balances, not
  // liabilities data. Free on the Trial plan; billable if we ever upgrade.
  if (list.includes('liabilities')) out.push(Products.Liabilities)
  return out.length ? out : [Products.Transactions]
}

// How much transaction history to request. THIS CANNOT BE CHANGED LATER.
// Plaid: "The maximum amount of transaction history to request on an Item cannot be updated if
// Transactions has already been added to the Item. To request older transaction history ... you must
// delete the Item via /item/remove and send the user through Link to create a new Item."
// On the Trial plan that means spending another unrefundable slot. The default is 90 days; the
// dashboard charts six months. 730 is the maximum and costs nothing.
const DAYS_REQUESTED = 730

export async function POST(req: Request) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: membership } = await supabase
    .from('memberships')
    .select('household_id')
    .limit(1)
    .single()
  if (!membership) return NextResponse.json({ error: 'no household' }, { status: 403 })

  const body = await req.json().catch(() => ({}) as Record<string, unknown>)
  const redirect_uri = process.env.PLAID_REDIRECT_URI || undefined

  // Plaid only sends webhooks to Items that were created with a webhook URL, and it cannot be added
  // to an Item afterwards — so this must be here before the first real bank is linked (Task 10).
  const webhook = process.env.PLAID_WEBHOOK_URL || undefined

  const base = {
    user: { client_user_id: user.id },
    client_name: 'Every Dollar Counts',
    language: 'en',
    country_codes: [CountryCode.Us],
    ...(redirect_uri ? { redirect_uri } : {}),
    ...(webhook ? { webhook } : {}),
  }

  // Update mode: reopen an existing item's login (reconnect). No products; uses access_token.
  if (body.mode === 'update' && typeof body.itemId === 'string') {
    const { data: item } = await supabaseAdmin
      .from('plaid_items')
      .select('access_token_encrypted, household_id')
      .eq('id', body.itemId)
      .single()
    if (!item || item.household_id !== membership.household_id) {
      return NextResponse.json({ error: 'not found' }, { status: 403 })
    }
    const r = await plaidClient.linkTokenCreate({
      ...base,
      access_token: decrypt(item.access_token_encrypted),
    })
    return NextResponse.json({ link_token: r.data.link_token })
  }

  // Add mode: new bank, with the requested products.
  const products = toProducts(body.products)
  const r = await plaidClient.linkTokenCreate({
    ...base,
    products,
    // Only meaningful when transactions is among the products, and it MUST be set here rather than
    // on transactions/sync when the Item is initialized with transactions at link time.
    ...(products.includes(Products.Transactions)
      ? { transactions: { days_requested: DAYS_REQUESTED } }
      : {}),
  })
  return NextResponse.json({ link_token: r.data.link_token })
}
```

- [ ] **Step 3: Typecheck, lint, build**

Run: `npx tsc --noEmit && npm run lint && npm run build`
Expected: all pass. (No unit test — this route has external side effects; it's covered by the manual sandbox exercise in Task 5 and §11.)

- [ ] **Step 4: Commit**

```bash
git add app/api/plaid/create-link-token/route.ts
git commit -m "feat(plaid): support update-mode and per-product link tokens with OAuth redirect"
```

---

## Task 4: Exchange route — store products, branch sync (brokerage = balances only)

**Files:**
- Modify: `app/api/plaid/exchange-public-token/route.ts`

**Interfaces:**
- Consumes: `storeAccounts`, `syncAndStore` (`@/lib/ingest`); `shouldSyncTransactions` (`@/lib/sync-policy`).
- Produces: `POST` body now also accepts `products?: string[]`; persists it on the item and only runs `syncAndStore` when the item carries `transactions`.

- [ ] **Step 1: Replace the route to persist products and branch on them**

Replace the entire contents of `app/api/plaid/exchange-public-token/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { plaidClient } from '@/lib/plaid'
import { encrypt } from '@/lib/crypto'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { storeAccounts, syncAndStore } from '@/lib/ingest'
import { shouldSyncTransactions } from '@/lib/sync-policy'

// Only the three product strings we support; default to transactions.
function normalizeProducts(input: unknown): string[] {
  const list = Array.isArray(input) ? input : []
  const out = list.filter(
    (p) => p === 'transactions' || p === 'investments' || p === 'liabilities'
  )
  return out.length ? (out as string[]) : ['transactions']
}

export async function POST(req: Request) {
  const { public_token, institution_name, products } = await req.json()
  if (!public_token) {
    return NextResponse.json({ error: 'public_token required' }, { status: 400 })
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: membership } = await supabase
    .from('memberships')
    .select('household_id')
    .limit(1)
    .single()
  if (!membership) return NextResponse.json({ error: 'no household' }, { status: 403 })
  const household_id = membership.household_id
  const productList = normalizeProducts(products)

  const { data: ex } = await plaidClient.itemPublicTokenExchange({ public_token })
  const accessToken = ex.access_token

  const { data: item, error: itemErr } = await supabaseAdmin
    .from('plaid_items')
    .insert({
      household_id,
      item_id: ex.item_id,
      access_token_encrypted: encrypt(accessToken),
      institution_name: institution_name ?? null,
      products: productList,
      // Stamp which Plaid environment this Item belongs to. All environments share one database and
      // a sandbox token fails against the production API with an error that is NOT recoverable by
      // reconnecting — see migration 010.
      plaid_env: process.env.PLAID_ENV === 'production' ? 'production' : 'sandbox',
    })
    .select('id')
    .single()

  // The Item already exists at Plaid — it was created the moment Link finished, before this route
  // ran. If we can't store it, we hold the only copy of its access token, so abandoning it here
  // would leave a live connection to a real bank that nothing can ever revoke, and would spend one
  // of ten unrefundable slots invisibly. Tear it down at Plaid, and log the id either way so it can
  // be removed by hand if that also fails.
  if (itemErr || !item) {
    console.error('[plaid] failed to store item', ex.item_id, itemErr?.message)
    try {
      await plaidClient.itemRemove({ access_token: accessToken })
    } catch (e) {
      console.error('[plaid] ALSO failed to remove orphaned item at Plaid', ex.item_id, e)
    }
    return NextResponse.json(
      { error: 'Could not save that bank. Nothing was connected — safe to try again.' },
      { status: 400 }
    )
  }

  // Balances come in for every item type (this is what makes brokerage and loan net worth work).
  await storeAccounts(household_id, item.id, accessToken)

  // Transactions only for transaction items. Note this does NOT error for investment/loan items —
  // it would silently attach the billable Transactions product to them. See lib/sync-policy.ts.
  let counts = { added: 0, modified: 0, removed: 0 }
  if (shouldSyncTransactions({ products: productList, status: 'ok' })) {
    counts = await syncAndStore({ id: item.id, household_id, access_token: accessToken })
  }

  return NextResponse.json({ ok: true, ...counts })
}
```

- [ ] **Step 2: Typecheck, lint, build**

Run: `npx tsc --noEmit && npm run lint && npm run build`
Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add app/api/plaid/exchange-public-token/route.ts
git commit -m "feat(plaid): record products on link and skip transaction sync for investment items"
```

---

## Task 5: Client link context, two-variant LinkButton, OAuth return page

**Files:**
- Create: `components/plaid-link-context.ts`, `app/plaid/oauth/page.tsx`
- Modify: `components/LinkButton.tsx`

**Interfaces:**
- Consumes: `create-link-token` (add mode), `exchange-public-token` (Task 4), `reconnect` (Task 6 — the `update` branch of `completePendingLink` calls it; the route lands in Task 6, so update-mode is only exercised from Task 6 onward).
- Produces:
  - `components/plaid-link-context.ts`: `type PendingLink`, `savePendingLink`, `loadPendingLink`, `clearPendingLink`, `completePendingLink(public_token, metadata)`.
  - `app/plaid/oauth/page.tsx`: the registered OAuth redirect target.

- [ ] **Step 1: Create the client link-context module**

Create `components/plaid-link-context.ts`:

```ts
'use client'

// Plaid Link survives an OAuth round-trip (bank's site → back to /plaid/oauth, a fresh page
// load) by stashing what it needs in localStorage. Non-OAuth banks never leave the page and
// read the same context in place. Both call completePendingLink on success.
//
// SSR GUARD, NON-NEGOTIABLE: /plaid/oauth is a client page with no dynamic APIs, so Next 16
// prerenders it at build time and these functions run on the server during `next build`. Guard on
// `typeof window`, NOT `typeof localStorage` — Node 22 defines a localStorage global, so the usual
// defensive check passes and the build still dies with "localStorage.getItem is not a function".
export type PendingLink = {
  token: string
  mode: 'add' | 'update'
  products?: string[]
  itemId?: string
  createdAt: number
}

const KEY = 'plaid_pending_link'

// Plaid link tokens expire: 4 hours for a new bank, 30 MINUTES in update mode. Expire ours slightly
// sooner so the user gets a plain "start again" instead of an opaque Link failure.
const MAX_AGE_MS = { add: 3 * 60 * 60 * 1000, update: 25 * 60 * 1000 }

export function savePendingLink(p: Omit<PendingLink, 'createdAt'>) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(KEY, JSON.stringify({ ...p, createdAt: Date.now() }))
}

export function loadPendingLink(): PendingLink | null {
  if (typeof window === 'undefined') return null
  const v = window.localStorage.getItem(KEY)
  if (!v) return null
  let ctx: PendingLink
  try {
    ctx = JSON.parse(v) as PendingLink
  } catch {
    clearPendingLink()
    return null
  }
  // A context left behind by an abandoned flow must not be resumed later.
  if (!ctx.createdAt || Date.now() - ctx.createdAt > MAX_AGE_MS[ctx.mode]) {
    clearPendingLink()
    return null
  }
  return ctx
}

export function clearPendingLink() {
  if (typeof window === 'undefined') return
  window.localStorage.removeItem(KEY)
}

// Finish whatever Link just completed. Add mode → exchange the public token for a stored,
// encrypted access token. Update mode (reconnect) → the access token is unchanged, so we just
// tell the server the item is healthy again and resync it.
//
// RETURNS ITS OUTCOME, and only clears the saved context on success. The Item already exists at
// Plaid by this point, so a silent failure here reads as "nothing happened" and invites the user to
// click Connect again — which spends a second unrefundable slot. Public tokens stay valid ~30
// minutes, so keeping the context means a retry actually retries instead of starting over.
export async function completePendingLink(
  public_token: string,
  metadata: { institution?: { name?: string } | null }
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = loadPendingLink()
  if (!ctx) return { ok: false, error: 'That connection attempt expired. Please start again.' }

  try {
    const res =
      ctx.mode === 'add'
        ? await fetch('/api/plaid/exchange-public-token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              public_token,
              institution_name: metadata?.institution?.name ?? null,
              products: ctx.products ?? ['transactions'],
            }),
          })
        : await fetch('/api/plaid/reconnect', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ itemId: ctx.itemId }),
          })

    if (!res.ok) {
      const body = await res.json().catch(() => ({}) as { error?: string })
      return { ok: false, error: body.error ?? "That didn't save. Don't try again yet." }
    }
  } catch {
    return { ok: false, error: "Couldn't reach the app. Check your connection, then retry." }
  }

  clearPendingLink()
  return { ok: true }
}
```

- [ ] **Step 2: Rewrite `LinkButton` with three variants**

Replace the entire contents of `components/LinkButton.tsx`:

```tsx
'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { usePlaidLink } from 'react-plaid-link'
import { buttonClass } from '@/components/ui/Button'
import { BankIcon } from '@/components/ui/icons'
import { savePendingLink, completePendingLink } from '@/components/plaid-link-context'

export function LinkButton() {
  const router = useRouter()
  const [token, setToken] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const onSuccess = useCallback(
    async (public_token: string, metadata: { institution?: { name?: string } | null }) => {
      setBusy(true)
      const result = await completePendingLink(public_token, metadata)
      setBusy(false)
      setToken(null)
      if (!result.ok) {
        // Loud on purpose: the Plaid connection already exists at this point, so a silent failure
        // invites a retry that spends another unrefundable slot.
        setError(result.error)
        return
      }
      setError(null)
      router.refresh()
    },
    [router]
  )

  // Link surfaces cancellation and bank-side failures through onExit, never by throwing.
  const onExit = useCallback((err: { display_message?: string | null } | null) => {
    clearPendingLink()
    setBusy(false)
    setToken(null)
    if (err) setError(err.display_message ?? "That didn't finish. Nothing was connected.")
  }, [])

  const { open, ready } = usePlaidLink({ token, onSuccess, onExit })

  // A token arrives only after the user picked a variant; open Link as soon as it's ready.
  useEffect(() => {
    if (token && ready) open()
  }, [token, ready, open])

  const start = useCallback(async (products: string[]) => {
    setError(null)
    const r = await fetch('/api/plaid/create-link-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'add', products }),
    })
      .then((res) => res.json())
      .catch(() => ({}) as { link_token?: string })
    if (!r.link_token) {
      setError("Couldn't start the connection. Please try again.")
      return
    }
    savePendingLink({ token: r.link_token, mode: 'add', products })
    setToken(r.link_token)
  }, [])

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => start(['transactions'])}
          disabled={busy}
          className={buttonClass('primary', 'md')}
        >
          <BankIcon className="h-[18px] w-[18px]" />
          {busy ? 'Connecting…' : 'Connect a bank'}
        </button>
        <button
          onClick={() => start(['investments'])}
          disabled={busy}
          className={buttonClass('secondary', 'md')}
        >
          Add investment account
        </button>
        <button
          onClick={() => start(['liabilities'])}
          disabled={busy}
          className={buttonClass('secondary', 'md')}
        >
          Add a loan or mortgage
        </button>
      </div>
      {error && (
        <p className="text-sm text-coral">
          {error} Don&apos;t click Connect again until you know what happened — every attempt uses
          one of your ten bank connections permanently.
        </p>
      )}
    </div>
  )
}
```

> **A mortgage at a bank you're already connecting doesn't need the third button.** Tick it in the
> same Link session as the checking account — same login, same Item, no extra slot. "Add a loan or
> mortgage" is only for a servicer that has no checking account, which Plaid otherwise hides from the
> list entirely.

Update the imports at the top of the file to include `clearPendingLink`:

```tsx
import { savePendingLink, clearPendingLink, completePendingLink } from '@/components/plaid-link-context'
```

- [ ] **Step 3: Create the OAuth return page**

Create `app/plaid/oauth/page.tsx`:

```tsx
'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { usePlaidLink } from 'react-plaid-link'
import { loadPendingLink, clearPendingLink, completePendingLink } from '@/components/plaid-link-context'

// Where an OAuth bank sends the user back to. Re-initialize Link with the SAME token we saved
// before redirecting, plus receivedRedirectUri, and Link resumes and fires onSuccess here.
//
// The token is read DURING RENDER, not in an effect. React 19's `react-hooks/set-state-in-effect`
// rule makes `useEffect(() => setToken(...), [])` a hard lint ERROR (and `next build` no longer runs
// ESLint, so the build would pass and the failure would surface much later). The SSR guard inside
// loadPendingLink is what makes a render-time read safe during prerendering.
export default function PlaidOAuthPage() {
  const router = useRouter()
  const [token] = useState<string | null>(() => loadPendingLink()?.token ?? null)
  const [error, setError] = useState<string | null>(null)

  const onSuccess = useCallback(
    async (public_token: string, metadata: { institution?: { name?: string } | null }) => {
      const result = await completePendingLink(public_token, metadata)
      if (!result.ok) {
        setError(result.error)
        return
      }
      router.replace('/dashboard')
    },
    [router]
  )

  const onExit = useCallback((err: { display_message?: string | null } | null) => {
    clearPendingLink()
    setError(err?.display_message ?? "That didn't finish.")
  }, [])

  const { open, ready } = usePlaidLink({
    token,
    receivedRedirectUri: typeof window !== 'undefined' ? window.location.href : undefined,
    onSuccess,
    onExit,
  })

  useEffect(() => {
    if (token && ready) open()
  }, [token, ready, open])

  // No saved context: an expired attempt, a different browser, or a private window. Never leave the
  // user on a spinner that cannot resolve — the bank connection may already exist at Plaid.
  if (!token || error) {
    return (
      <div className="grid min-h-screen place-items-center px-4">
        <div className="max-w-sm space-y-3 text-center">
          <h1 className="text-lg font-semibold text-ink">We couldn&apos;t finish that connection</h1>
          <p className="text-sm text-muted">
            {error ?? 'That attempt expired, or it was started in a different browser.'}
          </p>
          <p className="text-sm text-muted">
            Check Settings before trying again — if the bank is listed, it worked. Every fresh attempt
            uses one of your ten bank connections permanently.
          </p>
          <Link href="/settings" className="inline-block text-sm font-medium text-emerald">
            Go to Settings
          </Link>
        </div>
      </div>
    )
  }

  return <p className="p-8 text-sm text-muted">Finishing up your bank connection…</p>
}
```

- [ ] **Step 3b: Exempt `/plaid/oauth` from the login gate**

In `proxy.ts`, line 33, add `/plaid` to the public list:

```ts
  const isPublic =
    pathname.startsWith('/login') ||
    pathname.startsWith('/auth') ||
    pathname.startsWith('/plaid/oauth')
```

**Why this is required, not optional.** Verified against the production build: a request to
`/plaid/oauth` without a session returns `307 → /login`. A bank's own login routinely takes several
minutes of MFA and app-switching, which is exactly long enough for a session to lapse — and the user
comes back to the login page with the connection lost, while the Item exists at Plaid and the slot is
spent.

**Why it's safe:** the page renders no household data — it only re-opens the Plaid widget — and both
routes it calls (`exchange-public-token`, `reconnect`) independently verify the session and the
caller's household before doing anything.

- [ ] **Step 4: Typecheck, lint, build**

Run: `npx tsc --noEmit && npm run lint && npm run build`
Expected: all pass. (The `/api/plaid/reconnect` fetch target doesn't exist until Task 6; that's fine — it's a string URL, not an import, so nothing breaks at build time. Don't exercise reconnect until Task 6.)

- [ ] **Step 5: Manual sandbox verification — non-OAuth and OAuth add**

With `PLAID_ENV=sandbox` and `PLAID_REDIRECT_URI=http://localhost:3000/plaid/oauth` set locally, `npm run dev`, log in, and:
1. Click **Connect a bank**, choose a non-OAuth sandbox bank (First Platypus Bank, `ins_109508`), log in with `user_good` / `pass_good`. Expect: the dashboard shows the bank and its transactions.
2. Click **Connect a bank**, choose Plaid's sandbox **OAuth** institution (confirm the current one in Plaid's sandbox test-institution list — commonly "Platypus OAuth Bank", `ins_127287`). Expect: a redirect out and back to `/plaid/oauth`, then the dashboard shows the bank. (You must have registered `http://localhost:3000/plaid/oauth` as a redirect URI in the Plaid dashboard first.)
3. Click **Add investment account** and link a sandbox institution that supports Investments (confirm the id in Plaid's sandbox list). Expect: the account's balance appears and feeds net worth. **Verify the guard by querying the item's `cursor` column and confirming it is still `NULL`** — "no transactions appeared" proves nothing, since a brokerage has none either way.
4. **Rehearse the failure paths.** These are what spend slots, so they matter more than the happy path:
   - Open Link and cancel out of it. Expect: a plain message, no spinner, and `plaid_pending_link` cleared from localStorage.
   - Force the exchange to fail (e.g. temporarily point `exchange-public-token` at a bad table name, or stop the dev server between Link closing and the fetch). Expect: a visible error telling you **not** to retry blindly — not a silent page refresh.
   - Hand-edit `plaid_pending_link` in localStorage to set `createdAt` an hour in the past, then load `/plaid/oauth`. Expect: the "we couldn't finish that connection" page, not a hanging spinner.
5. **Verify the login-gate exemption.** With the app built (`npm run build && npm run start`), request `/plaid/oauth?oauth_state_id=test` with no session cookie. Expect: **200**, not a `307` redirect to `/login`.

- [ ] **Step 6: Commit**

```bash
git add components/plaid-link-context.ts components/LinkButton.tsx app/plaid/oauth/page.tsx proxy.ts
git commit -m "feat(plaid): OAuth redirect flow, three link variants, and visible link failures"
```

---

## Task 6: Reconnect — sync marks broken items, reconnect route, ReconnectButton

**Files:**
- Modify: `app/api/plaid/sync-transactions/route.ts`
- Create: `app/api/plaid/reconnect/route.ts`, `components/ReconnectButton.tsx`

**Interfaces:**
- Consumes: `isReconnectError`, `plaidErrorCode` (`@/lib/plaid-errors`); `shouldSyncTransactions` (`@/lib/sync-policy`); `storeAccounts`, `syncAndStore` (`@/lib/ingest`); `savePendingLink`, `completePendingLink` (`@/components/plaid-link-context`).
- Produces: `POST /api/plaid/reconnect` body `{ itemId }` → `{ ok }`; `ReconnectButton({ itemId }: { itemId: string })`.

- [ ] **Step 1: Rewrite the sync route to skip investment/broken items and mark newly-broken ones**

Replace the entire contents of `app/api/plaid/sync-transactions/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { decrypt } from '@/lib/crypto'
import { storeAccounts, syncAndStore } from '@/lib/ingest'
import { shouldSyncTransactions } from '@/lib/sync-policy'
import { isReconnectError, plaidErrorCode } from '@/lib/plaid-errors'

// Refresh: re-fetch balances and pull new transactions for every linked bank in the caller's
// household. A bank whose login is broken is marked needs_reconnect and skipped, not allowed
// to fail the whole refresh. Triggered by the "Refresh" button (and later, cron — see #15).
export async function POST() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: membership } = await supabase
    .from('memberships')
    .select('household_id')
    .limit(1)
    .single()
  if (!membership) return NextResponse.json({ error: 'no household' }, { status: 403 })
  const household_id = membership.household_id

  // Only items belonging to THIS Plaid environment. A sandbox item linked from a laptop after
  // go-live would otherwise be looped here, fail with INVALID_ACCESS_TOKEN, and (before the
  // catch-all below) take every real bank down with it.
  const plaidEnv = process.env.PLAID_ENV === 'production' ? 'production' : 'sandbox'

  const { data: items } = await supabaseAdmin
    .from('plaid_items')
    .select('id, household_id, access_token_encrypted, cursor, products, status')
    .eq('household_id', household_id)
    .eq('plaid_env', plaidEnv)

  let added = 0,
    modified = 0,
    removed = 0,
    brokenNow = 0,
    failed = 0,
    skipped = 0

  for (const item of items ?? []) {
    if (item.status === 'needs_reconnect') {
      skipped++
      continue
    }
    try {
      const token = decrypt(item.access_token_encrypted)
      await storeAccounts(item.household_id, item.id, token)
      if (shouldSyncTransactions({ products: item.products, status: item.status })) {
        const c = await syncAndStore({
          id: item.id,
          household_id: item.household_id,
          access_token: token,
          cursor: item.cursor,
        })
        added += c.added
        modified += c.modified
        removed += c.removed
      }
      // Recovered on its own (e.g. the bank came back up).
      if (item.status !== 'ok') {
        await supabaseAdmin
          .from('plaid_items')
          .update({ status: 'ok', status_detail: null })
          .eq('id', item.id)
      }
    } catch (e) {
      // NOTHING rethrows. One sick bank must never stop the others — that is the whole point of
      // this loop, and sandbox never produced the errors that make it matter. Production does:
      // INSTITUTION_DOWN, RATE_LIMIT_EXCEEDED, ITEM_LOCKED, PASSWORD_RESET_REQUIRED, and a failed
      // decrypt are all live possibilities.
      const code = plaidErrorCode(e) ?? 'UNKNOWN_ERROR'
      const status = isReconnectError(e)
        ? 'needs_reconnect'
        : isTemporaryError(e)
          ? 'temporarily_unavailable'
          : 'temporarily_unavailable'
      if (isReconnectError(e)) brokenNow++
      else failed++
      console.error('[plaid] sync failed for item', item.id, code, e)
      await supabaseAdmin
        .from('plaid_items')
        .update({ status, status_detail: code })
        .eq('id', item.id)
      continue
    }
  }

  return NextResponse.json({
    ok: true,
    banks: items?.length ?? 0,
    added,
    modified,
    removed,
    brokenNow,
    failed,
    skipped,
  })
}
```

Update the import to include `isTemporaryError`:

```ts
import { isReconnectError, isTemporaryError, plaidErrorCode } from '@/lib/plaid-errors'
```

> **Why unknown errors are treated as temporary rather than as "needs reconnect":** telling Sarah to
> reconnect a bank that is merely offline invites a disconnect-and-relink, which spends an
> unrefundable slot and fixes nothing. Defaulting to "wait" is the cheaper wrong answer.

- [ ] **Step 1b: Make `RefreshButton` report what happened**

`components/RefreshButton.tsx:14` currently does `await fetch('/api/plaid/sync-transactions', { method: 'POST' })`
and discards the result, so a failed refresh is visually identical to a successful one. Read the JSON
and show a plain summary — "Updated 4 banks, 12 new transactions", or "2 banks couldn't update" when
`failed > 0`, or a plain error when `!res.ok`. Silent staleness is the exact failure the spec exists
to eliminate; a Refresh button that swallows its own errors just relocates it.

- [ ] **Step 2: Create the reconnect route**

Create `app/api/plaid/reconnect/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { decrypt } from '@/lib/crypto'
import { storeAccounts, syncAndStore } from '@/lib/ingest'
import { shouldSyncTransactions } from '@/lib/sync-policy'

// Called after Link's update mode succeeds: the item's login is fixed (its access token is
// unchanged), so clear the broken flag and pull whatever we missed while it was down.
export async function POST(req: Request) {
  const { itemId } = await req.json()
  if (!itemId) return NextResponse.json({ error: 'itemId required' }, { status: 400 })

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: membership } = await supabase
    .from('memberships')
    .select('household_id')
    .limit(1)
    .single()
  if (!membership) return NextResponse.json({ error: 'no household' }, { status: 403 })

  const { data: item } = await supabaseAdmin
    .from('plaid_items')
    .select('id, household_id, access_token_encrypted, cursor, products')
    .eq('id', itemId)
    .single()
  if (!item || item.household_id !== membership.household_id) {
    return NextResponse.json({ error: 'not found' }, { status: 403 })
  }

  await supabaseAdmin
    .from('plaid_items')
    .update({ status: 'ok', status_detail: null })
    .eq('id', item.id)

  const token = decrypt(item.access_token_encrypted)
  await storeAccounts(item.household_id, item.id, token)
  if (shouldSyncTransactions({ products: item.products, status: 'ok' })) {
    await syncAndStore({
      id: item.id,
      household_id: item.household_id,
      access_token: token,
      cursor: item.cursor,
    })
  }

  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 3: Create `ReconnectButton`**

Create `components/ReconnectButton.tsx`:

```tsx
'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { usePlaidLink } from 'react-plaid-link'
import { buttonClass } from '@/components/ui/Button'
import { savePendingLink, completePendingLink } from '@/components/plaid-link-context'

// Reopens Link in update mode to fix a broken login. On success the access token is unchanged,
// so completePendingLink (update branch) just clears the broken flag and resyncs.
export function ReconnectButton({ itemId }: { itemId: string }) {
  const router = useRouter()
  const [token, setToken] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const onSuccess = useCallback(async () => {
    setBusy(true)
    await completePendingLink('', { institution: null })
    setBusy(false)
    setToken(null)
    router.refresh()
  }, [router])

  const { open, ready } = usePlaidLink({ token, onSuccess })

  useEffect(() => {
    if (token && ready) open()
  }, [token, ready, open])

  const start = useCallback(async () => {
    const r = await fetch('/api/plaid/create-link-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'update', itemId }),
    }).then((res) => res.json())
    if (!r.link_token) return
    savePendingLink({ token: r.link_token, mode: 'update', itemId })
    setToken(r.link_token)
  }, [itemId])

  return (
    <button onClick={start} disabled={busy} className={buttonClass('secondary', 'sm')}>
      {busy ? 'Reconnecting…' : 'Reconnect'}
    </button>
  )
}
```

- [ ] **Step 4: Typecheck, lint, build, unit tests**

Run: `npx tsc --noEmit && npm run lint && npm run build && npx vitest run`
Expected: all pass.

- [ ] **Step 5: Manual sandbox verification — force a broken item and fix it**

With a sandbox bank linked, force it into `ITEM_LOGIN_REQUIRED` (Plaid sandbox: call `/sandbox/item/reset_login` for the item's access token, e.g. via a one-off `node --env-file=.env.local` script using `plaidClient.sandboxItemResetLogin`). Then:
1. Click **Refresh**. Expect: the response includes `brokenNow: 1`, and the item's `status` in the DB is `needs_reconnect`.
2. Use the **Reconnect** button (rendered by Task 7's BankList; for an isolated check you can temporarily drop `<ReconnectButton itemId={...} />` onto the settings page). Re-auth with `user_good`/`pass_good`. Expect: `status` returns to `ok` and Refresh syncs normally again.

- [ ] **Step 6: Commit**

```bash
git add app/api/plaid/sync-transactions/route.ts app/api/plaid/reconnect/route.ts components/ReconnectButton.tsx
git commit -m "feat(plaid): detect broken bank logins on sync and add a reconnect flow"
```

---

## Task 7: Disconnect — remove-item route, bank listing, settings UI

**Files:**
- Create: `app/api/plaid/remove-item/route.ts`, `lib/plaid-items.ts`, `components/BankList.tsx`
- Modify: `app/(app)/settings/page.tsx`

**Interfaces:**
- Consumes: `plaidClient`, `supabaseAdmin`, `decrypt`, `ConfirmDialog` (`@/components/ui/ConfirmDialog`), `ReconnectButton` (Task 6).
- Produces:
  - `POST /api/plaid/remove-item` body `{ itemId }` → `{ ok }`.
  - `lib/plaid-items.ts`: `type ItemSummary = { id, institution_name, status, products, created_at }`; `listItemsForHousehold(householdId: string): Promise<ItemSummary[]>` — **safe columns only, never the token.**
  - `components/BankList.tsx`: `BankList({ items }: { items: ItemSummary[] })`.

- [ ] **Step 1: Create the item-listing helper**

Create `lib/plaid-items.ts`:

```ts
import 'server-only'
import { supabaseAdmin } from '@/lib/supabase/admin'

// Safe, display-only view of a household's linked banks. plaid_items has RLS with no client
// policy, so this reads via service_role — and deliberately selects only non-sensitive columns.
// NEVER add access_token_encrypted here.
export type ItemSummary = {
  id: string
  institution_name: string | null
  status: string
  products: string[]
  created_at: string
}

export async function listItemsForHousehold(householdId: string): Promise<ItemSummary[]> {
  const { data } = await supabaseAdmin
    .from('plaid_items')
    .select('id, institution_name, status, products, created_at')
    .eq('household_id', householdId)
    .order('created_at')
  return (data ?? []) as ItemSummary[]
}
```

- [ ] **Step 2: Create the remove-item route**

Create `app/api/plaid/remove-item/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { decrypt } from '@/lib/crypto'
import { plaidClient } from '@/lib/plaid'

// Disconnect a bank: remove it at Plaid, then delete our record. Deleting the plaid_items row
// cascades to accounts (002) and, via the FK added in 010, on to its transactions — so nothing
// is left counting toward spending.
export async function POST(req: Request) {
  const { itemId } = await req.json()
  if (!itemId) return NextResponse.json({ error: 'itemId required' }, { status: 400 })

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: membership } = await supabase
    .from('memberships')
    .select('household_id')
    .limit(1)
    .single()
  if (!membership) return NextResponse.json({ error: 'no household' }, { status: 403 })

  const { data: item } = await supabaseAdmin
    .from('plaid_items')
    .select('id, household_id, access_token_encrypted')
    .eq('id', itemId)
    .single()
  if (!item || item.household_id !== membership.household_id) {
    return NextResponse.json({ error: 'not found' }, { status: 403 })
  }

  // Decrypt OUTSIDE the try. The access token is the ONLY way to revoke this connection at Plaid.
  // If we can't decrypt it (rotated/lost TOKEN_ENCRYPTION_KEY, corrupted ciphertext) we must not
  // delete the row — doing so leaves a live connection to a real bank login that nothing can ever
  // revoke, while the UI cheerfully reports "disconnected" and the slot stays spent.
  let accessToken: string
  try {
    accessToken = decrypt(item.access_token_encrypted)
  } catch {
    return NextResponse.json(
      { error: 'Could not read this bank’s saved credential, so it was not disconnected.' },
      { status: 500 }
    )
  }

  // Swallow ONLY "it's already gone there". Any other failure (Plaid 5xx, network) keeps the row so
  // the user can retry, rather than silently orphaning the connection.
  try {
    await plaidClient.itemRemove({ access_token: accessToken })
  } catch (e) {
    const code = plaidErrorCode(e)
    if (code !== 'ITEM_NOT_FOUND' && code !== 'INVALID_ACCESS_TOKEN') {
      console.error('[plaid] itemRemove failed', item.id, code, e)
      return NextResponse.json(
        { error: 'Plaid could not disconnect that bank just now. Nothing was changed — try again.' },
        { status: 502 }
      )
    }
  }

  const { error } = await supabaseAdmin.from('plaid_items').delete().eq('id', item.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 400 })

  return NextResponse.json({ ok: true })
}
```

Add `plaidErrorCode` to the imports:

```ts
import { plaidErrorCode } from '@/lib/plaid-errors'
```

- [ ] **Step 3: Create `BankList`**

Create `components/BankList.tsx`:

```tsx
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { ReconnectButton } from '@/components/ReconnectButton'
import { buttonClass } from '@/components/ui/Button'
import type { ItemSummary } from '@/lib/plaid-items'

export function BankList({ items }: { items: ItemSummary[] }) {
  const router = useRouter()
  const [pendingRemove, setPendingRemove] = useState<ItemSummary | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function disconnect(item: ItemSummary) {
    setBusy(true)
    const res = await fetch('/api/plaid/remove-item', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId: item.id }),
    }).catch(() => null)
    setBusy(false)
    setPendingRemove(null)
    // A failed disconnect means the bank is STILL connected at Plaid. Saying nothing would let the
    // user believe a real credential was revoked when it wasn't.
    if (!res || !res.ok) {
      const body = res ? await res.json().catch(() => ({}) as { error?: string }) : {}
      setError(body.error ?? 'That bank was not disconnected. It is still connected at Plaid.')
      return
    }
    setError(null)
    router.refresh()
  }

  if (items.length === 0) {
    return <p className="text-sm text-muted">No banks connected yet.</p>
  }

  return (
    <>
      {error && <p className="pb-2 text-sm text-coral">{error}</p>}
      {/* The slot budget has to be visible, not remembered: 10 lifetime, never refunded. */}
      <p className="pb-2 text-xs text-muted">
        Bank connections used: {items.length} of 10. Disconnecting one does not give it back.
      </p>
      <ul className="divide-y divide-line">
        {items.map((item) => (
          <li key={item.id} className="flex items-center justify-between py-3">
            <div>
              <p className="text-sm font-medium text-ink">
                {item.institution_name ?? 'Linked bank'}
              </p>
              {item.status === 'needs_reconnect' ? (
                <p className="text-xs text-coral">Connection lost — reconnect to resume syncing.</p>
              ) : item.status === 'temporarily_unavailable' ? (
                <p className="text-xs text-muted">
                  This bank didn&apos;t respond last time. Nothing to do — try Refresh later.
                </p>
              ) : (
                <p className="text-xs text-muted">Connected</p>
              )}
            </div>
            <div className="flex items-center gap-2">
              {item.status === 'needs_reconnect' && <ReconnectButton itemId={item.id} />}
              <button
                onClick={() => setPendingRemove(item)}
                className={buttonClass('secondary', 'sm')}
              >
                Disconnect
              </button>
            </div>
          </li>
        ))}
      </ul>

      <ConfirmDialog
        open={pendingRemove !== null}
        title={`Disconnect ${pendingRemove?.institution_name ?? 'this bank'}?`}
        confirmLabel="Disconnect"
        busy={busy}
        onConfirm={() => pendingRemove && disconnect(pendingRemove)}
        onCancel={() => setPendingRemove(null)}
      >
        <p>This removes the bank and deletes its accounts and transactions.</p>
        <p>
          Your Plaid connection slot is not refunded — re-linking later counts as a new
          connection.
        </p>
      </ConfirmDialog>
    </>
  )
}
```

- [ ] **Step 4: Wire `BankList` into the settings page**

In `app/(app)/settings/page.tsx`, add the import near the other component imports:

```tsx
import { BankList } from '@/components/BankList'
import { listItemsForHousehold } from '@/lib/plaid-items'
```

Then, inside `SettingsPage`, after `const household = households?.[0]`, add:

```tsx
  const items = household ? await listItemsForHousehold(household.id) : []
```

Finally, replace the Banks card body (the `<p>…account(s) connected…</p>` and `<LinkButton />`) with:

```tsx
      <Card className="p-5 space-y-3">
        <h2 className="text-base font-semibold text-ink">Banks</h2>
        <BankList items={items} />
        <LinkButton />
      </Card>
```

- [ ] **Step 5: Typecheck, lint, build**

Run: `npx tsc --noEmit && npm run lint && npm run build`
Expected: all pass.

- [ ] **Step 6: Manual sandbox verification — disconnect removes transactions too**

Link a sandbox bank so it has accounts and transactions. Note a transaction count on the Transactions page. On Settings, click **Disconnect**, confirm. Expect: the bank disappears, and its transactions are gone from the Transactions page and dashboard totals (verify with a DB query that no `transactions` rows remain for the removed item's account IDs — the cascade should leave zero).

- [ ] **Step 7: Commit**

```bash
git add app/api/plaid/remove-item/route.ts lib/plaid-items.ts components/BankList.tsx "app/(app)/settings/page.tsx"
git commit -m "feat(plaid): disconnect a bank from settings, cascading its transactions (closes #11)"
```

---

## Task 8: Dashboard broken-bank banner

**Files:**
- Modify: `app/(app)/dashboard/page.tsx`

**Interfaces:**
- Consumes: `listItemsForHousehold` (`@/lib/plaid-items`).

- [ ] **Step 1: Fetch items and render a banner when any bank is broken**

In `app/(app)/dashboard/page.tsx`, add the import:

```tsx
import { listItemsForHousehold } from '@/lib/plaid-items'
```

Inside `DashboardPage`, after `const accounts = accountsData ?? []`, add:

```tsx
  const { data: membership } = await supabase
    .from('memberships')
    .select('household_id')
    .limit(1)
    .single()
  const items = membership ? await listItemsForHousehold(membership.household_id) : []
  const hasBrokenBank = items.some((i) => i.status === 'needs_reconnect')
```

Then, in the returned JSX for the main (non-empty) branch, immediately after the opening `<div className="space-y-6">` and before `<PageHeader …>`, add:

```tsx
      {hasBrokenBank && (
        <Link
          href="/settings"
          className="block rounded-card border border-coral/40 bg-coral/10 px-4 py-3 text-sm text-coral"
        >
          A bank connection needs attention — reconnect it in Settings to resume syncing.
        </Link>
      )}
```

(`Link` is already imported at the top of this file.)

- [ ] **Step 2: Typecheck, lint, build**

Run: `npx tsc --noEmit && npm run lint && npm run build`
Expected: all pass.

- [ ] **Step 3: Manual verification**

With a bank forced into `needs_reconnect` (as in Task 6), load the dashboard. Expect: the banner appears and links to Settings. Reconnect the bank; reload. Expect: the banner is gone.

- [ ] **Step 4: Commit**

```bash
git add "app/(app)/dashboard/page.tsx"
git commit -m "feat(dashboard): warn when a bank connection needs reconnecting"
```

---

## Task 9: Sandbox reset script and go-live runbook

**Files:**
- Create: `scripts/reset-plaid-data.mjs`, `docs/plaid-production-cutover.md`

**Interfaces:**
- Consumes: `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_URL` from env.

- [ ] **Step 1: Create the guarded reset script**

Create `scripts/reset-plaid-data.mjs`:

```js
// Deletes SANDBOX linked banks and their data, so the app can be re-linked against real banks.
// Deleting plaid_items cascades to accounts (002) and, via the 010 FK, to transactions.
// KEEPS households, memberships, categories, budgets, and goals — and every production item.
// Usage: node --env-file=.env.local scripts/reset-plaid-data.mjs --confirm
//
// WHY THIS IS SCOPED TO plaid_env='sandbox' RATHER THAN "delete everything":
// there is exactly ONE Supabase project behind local dev, preview, and production. A --confirm flag
// is no protection at all when the same command, run a day later out of shell history, would wipe
// real bank data. The environment filter is the actual guard; --confirm is a speed bump.
import { createClient } from '@supabase/supabase-js'

if (!process.argv.includes('--confirm')) {
  console.error(
    'Refusing to run without --confirm. This deletes sandbox-linked banks and their transactions.'
  )
  process.exit(1)
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const svc = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !svc) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.')
  process.exit(1)
}

const admin = createClient(url, svc, { auth: { persistSession: false } })

// Refuse to touch production rows, and say plainly what is being kept.
const { data: prod } = await admin
  .from('plaid_items')
  .select('id')
  .eq('plaid_env', 'production')

const { data: items, error: readErr } = await admin
  .from('plaid_items')
  .select('id')
  .eq('plaid_env', 'sandbox')
if (readErr) {
  console.error('Could not read plaid_items:', readErr.message)
  process.exit(1)
}

const { error } = await admin.from('plaid_items').delete().eq('plaid_env', 'sandbox')
if (error) {
  console.error('Delete failed:', error.message)
  process.exit(1)
}

console.log(
  `✓ Removed ${items?.length ?? 0} sandbox bank(s); their accounts and transactions cascaded away.`
)
console.log(
  `✓ Left ${prod?.length ?? 0} production bank(s) untouched. Households, categories, budgets, and goals kept.`
)
```

> **Delete this script once the cutover is done.** It has one job and one day to do it, and it lives
> in a repo whose only database is the real one.

- [ ] **Step 2: Create the go-live runbook**

Create `docs/plaid-production-cutover.md`:

```markdown
# Going live on real bank data — cutover runbook

Do these in order. Steps 0–6 are reversible; step 8 onward spends unrefundable bank connections.

**The one rule for the whole day:** if a bank doesn't appear after you connect it, **STOP**. Do not
click Connect again. Check Settings first — if it's listed, it worked. Every fresh attempt spends one
of your ten connections permanently, and they are never refunded.

0. **Back up the database.** Supabase → Database → Backups → take a manual backup. (Or Table Editor →
   export `plaid_items`, `accounts`, and `transactions` to CSV and save them to Drive.) There is no
   down-migration and no second database. This is the only rollback that exists. Confirm the file
   exists before continuing.
1. **Back up the encryption key.** Copy `TOKEN_ENCRYPTION_KEY` from Vercel into the password vault
   and confirm it matches. Losing it is unrecoverable and looks exactly like a security incident.
2. **Do the Plaid dashboard setup** (nothing works without this):
   - Register the OAuth redirect URI `https://every-dollar-counts.vercel.app/plaid/oauth`.
   - Set the app display name to "Every Dollar Counts" — this is what the bank's consent screen shows.
   - Copy the **production** `client_id` and `secret` (different values from the sandbox ones).
   - While you're there: search the institution coverage explorer for any standalone loan servicer
     you plan to connect, and check it supports `liabilities`. Free, and it may save a wasted attempt.
3. **Ship the code.** Merge `feature/plaid-production` to `main` (Vercel auto-deploys).
4. **Apply the migration.** Run `db/migrations/010_plaid_production.sql` against the production
   Supabase project. Verify the four new columns and the `transactions_account_id_fkey`
   constraint exist (query in Task 1). *(The spec worried the FK couldn't be added before the
   sandbox reset because of orphaned rows. It can: no orphans exist yet — the disconnect feature
   that creates them is brand new — and the migration's defensive delete covers the case anyway.
   Migrating first is cleaner: the reset in step 5 then cascades transactions away automatically.)*
5. **Purge the sandbox data.**
   `node --env-file=.env.local scripts/reset-plaid-data.mjs --confirm`
   It deletes only rows tagged `plaid_env='sandbox'` and reports how many production rows it left
   alone. It keeps categories, budgets, and goals.
6. **Set production env on Vercel (production scope only):**
   - `PLAID_ENV=production` — spelled exactly that, lowercase. Any other value silently falls back
     to sandbox.
   - `PLAID_CLIENT_ID` / `PLAID_SECRET` = the **production** credentials
   - `PLAID_REDIRECT_URI=https://every-dollar-counts.vercel.app/plaid/oauth`
   - Leave `TOKEN_ENCRYPTION_KEY` unchanged.
   - Set `PLAID_ENV=sandbox` explicitly on the **Preview** and **Development** scopes too, so a
     preview deploy can never reach production Plaid.
7. **REDEPLOY. This step is not optional and is easy to miss.**
   Vercel → Deployments → the top production deployment → ⋯ → **Redeploy** (uncheck "use existing
   build cache"). Wait for **Ready**.
   *Environment variables do not apply to deployments that already exist.* Without this, the live
   site is still the sandbox build, and step 9 would show you fake banks — or send real bank
   credentials into a sandbox session.
8. **Prove it's really production — costs nothing.** Open the live site, click **Connect a bank**,
   and search "Chase". A real Chase logo means production. "First Platypus Bank" means the redeploy
   didn't take — go back to step 7. **Close Link without finishing.**
9. **Link one real bank.** Confirm the balance matches the bank's own website.
   **Transactions will not appear right away.** Plaid's first pull runs for minutes to hours; an
   empty transaction list at this point is normal, not broken. Wait, then press **Refresh** again.
   Do not re-link.
10. **Link the rest** — credit cards, brokerage (balances only), loans. If a mortgage is at a bank
    you're already connecting, tick it in that same Link session; it costs no extra connection.
11. **Check the numbers, not just their presence:**
    - Adding a credit card should make net worth go **down**.
    - If a mortgage came in alongside checking, watch for the monthly payment being counted twice —
      once leaving checking, once arriving at the loan.
    - Watch for refunds landing in Income (bug #8). With real cards this starts within days.
    - Confirm net worth against a number you already know to be true.

## If it goes wrong

- **A bank didn't appear.** Check Settings. If it's listed, it worked. If not, check the Vercel
  runtime logs for `[plaid]` before retrying — the connection may exist at Plaid even though the app
  never stored it.
- **Nothing syncs at all.** Almost always step 7 — the redeploy. Check the live site shows real
  banks, not Platypus.
- **You need to back out entirely.** Set `PLAID_ENV=sandbox`, redeploy, and run the reset script
  (it now only clears sandbox rows, so first delete the production rows by hand in the Supabase table
  editor). Then restore from the step-0 backup if needed. **Be clear-eyed: any real bank already
  linked has spent its connection, and rolling back does not return it.**

Trial plan: 10 linked banks, lifetime, unrefundable. Upgrading to full Production later is documented
in `docs/plaid-production-application.md`.
```

- [ ] **Step 3: Verify the guard**

Run without the flag: `node --env-file=.env.local scripts/reset-plaid-data.mjs`
Expected: exits non-zero with the "Refusing to run without --confirm" message, deletes nothing.

> **The original instruction here — "run it with `--confirm` against a sandbox project you're willing
> to clear" — was impossible and dangerous, and has been removed.** There is no sandbox project. The
> only Supabase credentials that exist point at the real database, so following that step literally
> would have wiped production *before* the migration and *before* the deploy. The real proof that the
> `--confirm` path works comes on cutover day, when it runs against sandbox-tagged rows with a fresh
> backup sitting behind it (runbook steps 0 and 5).

- [ ] **Step 4: Commit**

```bash
git add scripts/reset-plaid-data.mjs docs/plaid-production-cutover.md
git commit -m "feat: guarded sandbox reset script and production cutover runbook"
```

---

## Task 10: Plaid webhooks — know when a bank breaks and when data lands

**Files:**
- Create: `app/api/plaid/webhook/route.ts`
- Modify: `.env.example` (done in Task 1)

**Why this is in scope** (it was originally deferred as #14): `PENDING_EXPIRATION` and
`PENDING_DISCONNECT` are webhook codes that **never** appear as API errors, so without a receiver
they cannot be observed at all. Plaid is force-migrating Bank of America Items through late 2026 and
gives a one-week `PENDING_DISCONNECT` warning before the connection drops. This route is also what
tells us the first transaction pull has finished, which is the thing most likely to make a real link
look broken and tempt a slot-burning re-link.

**Interfaces:**
- Produces: `POST /api/plaid/webhook` → `{ ok }`. No auth session — Plaid calls it, not a browser.

- [ ] **Step 1: Create the webhook route**

Create `app/api/plaid/webhook/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { decrypt } from '@/lib/crypto'
import { storeAccounts, syncAndStore } from '@/lib/ingest'
import { shouldSyncTransactions } from '@/lib/sync-policy'

// Plaid calls this; there is no user session. Item webhooks that mean "the login is broken or about
// to break" set status; transaction webhooks mean fresh data is ready, so we pull it.
const BREAKING = new Set([
  'ERROR',
  'PENDING_EXPIRATION',
  'PENDING_DISCONNECT',
  'USER_PERMISSION_REVOKED',
])
const DATA_READY = new Set(['INITIAL_UPDATE', 'HISTORICAL_UPDATE', 'DEFAULT_UPDATE', 'SYNC_UPDATES_AVAILABLE'])

export async function POST(req: Request) {
  // Shared secret on the URL registered with Plaid. This is a pragmatic guard, not Plaid's full
  // JWT verification (/webhook_verification_key/get + ES256). Worth knowing what it does and doesn't
  // buy: it stops anonymous internet noise, but a leaked URL is a leaked credential. The blast
  // radius is limited — a forged call can mark a bank as broken or trigger a sync, not read data.
  const key = new URL(req.url).searchParams.get('key')
  if (!process.env.PLAID_WEBHOOK_SECRET || key !== process.env.PLAID_WEBHOOK_SECRET) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  const body = await req.json().catch(() => null)
  if (!body?.item_id) return NextResponse.json({ ok: true })

  const { webhook_type, webhook_code, item_id, error } = body

  const { data: item } = await supabaseAdmin
    .from('plaid_items')
    .select('id, household_id, access_token_encrypted, cursor, products, status')
    .eq('item_id', item_id)
    .maybeSingle()
  // Unknown item (e.g. one abandoned by a failed exchange) — acknowledge so Plaid stops retrying.
  if (!item) return NextResponse.json({ ok: true })

  if (webhook_type === 'ITEM' && BREAKING.has(webhook_code)) {
    await supabaseAdmin
      .from('plaid_items')
      .update({
        status: 'needs_reconnect',
        status_detail: error?.error_code ?? webhook_code,
      })
      .eq('id', item.id)
    return NextResponse.json({ ok: true })
  }

  if (webhook_type === 'TRANSACTIONS' && DATA_READY.has(webhook_code)) {
    try {
      const token = decrypt(item.access_token_encrypted)
      await storeAccounts(item.household_id, item.id, token)
      if (shouldSyncTransactions({ products: item.products, status: item.status })) {
        await syncAndStore({
          id: item.id,
          household_id: item.household_id,
          access_token: token,
          cursor: item.cursor,
        })
      }
    } catch (e) {
      // Never fail the webhook — Plaid retries, and a 500 loop helps nobody. The Refresh button
      // remains the backstop.
      console.error('[plaid] webhook sync failed', item.id, e)
    }
  }

  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 2: Typecheck, lint, build**

Run: `npx tsc --noEmit && npm run lint && npm run build`
Expected: all pass.

- [ ] **Step 3: Manual sandbox verification**

Set `PLAID_WEBHOOK_SECRET` locally and POST a fake payload to the route with the right `?key=`,
using an `item_id` that exists in the DB:

```bash
curl -X POST "http://localhost:3000/api/plaid/webhook?key=$PLAID_WEBHOOK_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{"webhook_type":"ITEM","webhook_code":"PENDING_DISCONNECT","item_id":"<a real item_id>"}'
```

Expect: that item's `status` becomes `needs_reconnect` and the dashboard banner appears. Then POST
the same payload **without** the `key` parameter and expect a 404 with no change to the row.

- [ ] **Step 4: Commit**

```bash
git add app/api/plaid/webhook/route.ts
git commit -m "feat(plaid): receive item and transaction webhooks (closes #14)"
```

---

## Final verification

- [ ] `npx vitest run` — all unit tests pass (including the two new helper suites).
- [ ] `npx tsc --noEmit && npm run lint && npm run build && npm run check:secrets` — all clean.
      **Run lint explicitly — `next build` no longer runs ESLint, so a hard lint error can pass the build.**
- [ ] The manual sandbox exercises in Tasks 5, 6, 7, 8, 10 have all been performed successfully,
      **including the failure-path rehearsals in Task 5 Step 5.** Those are the ones that protect
      Item slots, and they are the easiest to skip because everything "already works."
- [ ] `curl -D - http://localhost:3999/plaid/oauth` on a production build returns **200**, not a 307
      to `/login`.
- [ ] Open a PR from `feature/plaid-production` (PR #16 already tracks the docs; this adds the code).
- [ ] Before running the cutover runbook: the Plaid dashboard setup (redirect URI, display name,
      production keys, webhook URL) is **done**, and the database and `TOKEN_ENCRYPTION_KEY` are
      backed up. The Trial plan is approved as of 2026-07-23, so approval is no longer the gate —
      the rehearsal is.
```
