# Plaid Production Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take the app from Plaid's sandbox to real bank data — build the OAuth redirect and the reconnect/disconnect flows that sandbox never forced us to build, add balances-only brokerage support, and cut cleanly over from fake data.

**Architecture:** The `PLAID_ENV` switch, token encryption, and RLS already exist and don't change. This plan adds: a DB migration (link status, product tracking, cascade cleanup), two tested pure helpers, changes to the three existing Plaid routes, three new routes (reconnect, remove-item, and the exchange already exists), an OAuth completion page, and small UI for reconnect/disconnect. Testable logic is pure functions with unit tests; routes, pages, and scripts follow the repo's existing convention (no route/component tests) and are verified by build + typecheck + manual sandbox exercise.

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
- `scripts/reset-plaid-data.mjs` — guarded sandbox→production data purge
- `docs/plaid-production-cutover.md` — go-live runbook
- `tests/unit/plaid-errors.test.ts`, `tests/unit/sync-policy.test.ts`

**Modify:**
- `app/api/plaid/create-link-token/route.ts` — add/update modes + `redirect_uri`
- `app/api/plaid/exchange-public-token/route.ts` — store `products`, branch sync
- `app/api/plaid/sync-transactions/route.ts` — skip investment/broken items, mark broken
- `components/LinkButton.tsx` — two variants (bank vs investment), save link context
- `app/(app)/settings/page.tsx` — render `BankList`
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
alter table plaid_items
  add column if not exists status text not null default 'ok',
  add column if not exists status_detail text,
  add column if not exists products text[] not null default '{transactions}';

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
```

- [ ] **Step 3: Apply the migration to the Supabase project and verify**

Apply `010_plaid_production.sql` in the Supabase SQL editor (or your migration runner), then run this check:

```sql
select column_name from information_schema.columns
  where table_name = 'plaid_items' and column_name in ('status','status_detail','products');
select constraint_name from information_schema.table_constraints
  where table_name = 'transactions' and constraint_name = 'transactions_account_id_fkey';
```

Expected: three column rows, and one constraint row.

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
  it('is true for login-required and expiration codes', () => {
    expect(isReconnectError(plaidError('ITEM_LOGIN_REQUIRED'))).toBe(true)
    expect(isReconnectError(plaidError('PENDING_EXPIRATION'))).toBe(true)
  })
  it('is false for unrelated Plaid errors and non-Plaid errors', () => {
    expect(isReconnectError(plaidError('INVALID_ACCESS_TOKEN'))).toBe(false)
    expect(isReconnectError(new Error('network'))).toBe(false)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/unit/plaid-errors.test.ts`
Expected: FAIL — cannot resolve `@/lib/plaid-errors`.

- [ ] **Step 3: Implement `lib/plaid-errors.ts`**

```ts
// Reconnect-relevant Plaid error codes: the item's login is broken and the user must
// re-authenticate through Link's update mode. PENDING_EXPIRATION/PENDING_DISCONNECT are
// warnings that the connection is about to break; we treat them the same.
const RECONNECT_CODES = new Set([
  'ITEM_LOGIN_REQUIRED',
  'PENDING_EXPIRATION',
  'PENDING_DISCONNECT',
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
// Whether we should call transactions/sync for an item. Investment items are balances-only
// (calling transactions/sync on them errors), and a broken item is skipped until reconnected.
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

// Map the client's requested product strings to Plaid's enum. Only the two we support.
function toProducts(input: unknown): Products[] {
  const list = Array.isArray(input) ? input : ['transactions']
  const out: Products[] = []
  if (list.includes('transactions')) out.push(Products.Transactions)
  if (list.includes('investments')) out.push(Products.Investments)
  return out.length ? out : [Products.Transactions]
}

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

  const base = {
    user: { client_user_id: user.id },
    client_name: 'Every Dollar Counts',
    language: 'en',
    country_codes: [CountryCode.Us],
    ...(redirect_uri ? { redirect_uri } : {}),
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
  const r = await plaidClient.linkTokenCreate({
    ...base,
    products: toProducts(body.products),
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

// Only the two product strings we support; default to transactions.
function normalizeProducts(input: unknown): string[] {
  const list = Array.isArray(input) ? input : []
  const out = list.filter((p) => p === 'transactions' || p === 'investments')
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
    })
    .select('id')
    .single()
  if (itemErr || !item) {
    return NextResponse.json({ error: itemErr?.message ?? 'store failed' }, { status: 400 })
  }

  // Balances come in for every item type (this is what makes brokerage net worth work).
  await storeAccounts(household_id, item.id, accessToken)

  // Transactions only for transaction items — calling transactions/sync on an investment
  // item errors.
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
// Plaid Link survives an OAuth round-trip (bank's site → back to /plaid/oauth, a fresh page
// load) by stashing what it needs in localStorage. Non-OAuth banks never leave the page and
// read the same context in place. Both call completePendingLink on success.
export type PendingLink = {
  token: string
  mode: 'add' | 'update'
  products?: string[]
  itemId?: string
}

const KEY = 'plaid_pending_link'

export function savePendingLink(p: PendingLink) {
  localStorage.setItem(KEY, JSON.stringify(p))
}

export function loadPendingLink(): PendingLink | null {
  const v = localStorage.getItem(KEY)
  return v ? (JSON.parse(v) as PendingLink) : null
}

export function clearPendingLink() {
  localStorage.removeItem(KEY)
}

// Finish whatever Link just completed. Add mode → exchange the public token for a stored,
// encrypted access token. Update mode (reconnect) → the access token is unchanged, so we just
// tell the server the item is healthy again and resync it.
export async function completePendingLink(
  public_token: string,
  metadata: { institution?: { name?: string } | null }
) {
  const ctx = loadPendingLink()
  if (!ctx) return
  if (ctx.mode === 'add') {
    await fetch('/api/plaid/exchange-public-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        public_token,
        institution_name: metadata?.institution?.name ?? null,
        products: ctx.products ?? ['transactions'],
      }),
    })
  } else {
    await fetch('/api/plaid/reconnect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId: ctx.itemId }),
    })
  }
  clearPendingLink()
}
```

- [ ] **Step 2: Rewrite `LinkButton` with two variants**

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

  const onSuccess = useCallback(
    async (public_token: string, metadata: { institution?: { name?: string } | null }) => {
      setBusy(true)
      await completePendingLink(public_token, metadata)
      setBusy(false)
      setToken(null)
      router.refresh()
    },
    [router]
  )

  const { open, ready } = usePlaidLink({ token, onSuccess })

  // A token arrives only after the user picked a variant; open Link as soon as it's ready.
  useEffect(() => {
    if (token && ready) open()
  }, [token, ready, open])

  const start = useCallback(async (products: string[]) => {
    const r = await fetch('/api/plaid/create-link-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'add', products }),
    }).then((res) => res.json())
    if (!r.link_token) return
    savePendingLink({ token: r.link_token, mode: 'add', products })
    setToken(r.link_token)
  }, [])

  return (
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
    </div>
  )
}
```

- [ ] **Step 3: Create the OAuth return page**

Create `app/plaid/oauth/page.tsx`:

```tsx
'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { usePlaidLink } from 'react-plaid-link'
import { loadPendingLink, completePendingLink } from '@/components/plaid-link-context'

// Where an OAuth bank sends the user back to. Re-initialize Link with the SAME token we saved
// before redirecting, plus receivedRedirectUri, and Link resumes and fires onSuccess here.
export default function PlaidOAuthPage() {
  const router = useRouter()
  const [token, setToken] = useState<string | null>(null)

  useEffect(() => {
    setToken(loadPendingLink()?.token ?? null)
  }, [])

  const { open, ready } = usePlaidLink({
    token,
    receivedRedirectUri: typeof window !== 'undefined' ? window.location.href : undefined,
    onSuccess: async (public_token, metadata) => {
      await completePendingLink(public_token, metadata)
      router.replace('/dashboard')
    },
  })

  useEffect(() => {
    if (token && ready) open()
  }, [token, ready, open])

  return <p className="p-8 text-sm text-muted">Finishing up your bank connection…</p>
}
```

- [ ] **Step 4: Typecheck, lint, build**

Run: `npx tsc --noEmit && npm run lint && npm run build`
Expected: all pass. (The `/api/plaid/reconnect` fetch target doesn't exist until Task 6; that's fine — it's a string URL, not an import, so nothing breaks at build time. Don't exercise reconnect until Task 6.)

- [ ] **Step 5: Manual sandbox verification — non-OAuth and OAuth add**

With `PLAID_ENV=sandbox` and `PLAID_REDIRECT_URI=http://localhost:3000/plaid/oauth` set locally, `npm run dev`, log in, and:
1. Click **Connect a bank**, choose a non-OAuth sandbox bank (First Platypus Bank, `ins_109508`), log in with `user_good` / `pass_good`. Expect: the dashboard shows the bank and its transactions.
2. Click **Connect a bank**, choose Plaid's sandbox **OAuth** institution (confirm the current one in Plaid's sandbox test-institution list — commonly "Platypus OAuth Bank", `ins_127287`). Expect: a redirect out and back to `/plaid/oauth`, then the dashboard shows the bank. (You must have registered `http://localhost:3000/plaid/oauth` as a redirect URI in the Plaid dashboard first.)
3. Click **Add investment account** and link a sandbox institution that supports Investments (confirm the id in Plaid's sandbox list). Expect: the account's balance appears and feeds net worth; no transactions are ingested for it.

- [ ] **Step 6: Commit**

```bash
git add components/plaid-link-context.ts components/LinkButton.tsx app/plaid/oauth/page.tsx
git commit -m "feat(plaid): OAuth redirect flow and bank-vs-investment link variants"
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

  const { data: items } = await supabaseAdmin
    .from('plaid_items')
    .select('id, household_id, access_token_encrypted, cursor, products, status')
    .eq('household_id', household_id)

  let added = 0,
    modified = 0,
    removed = 0,
    brokenNow = 0,
    skipped = 0

  for (const item of items ?? []) {
    if (item.status === 'needs_reconnect') {
      skipped++
      continue
    }
    const token = decrypt(item.access_token_encrypted)
    try {
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
    } catch (e) {
      if (isReconnectError(e)) {
        await supabaseAdmin
          .from('plaid_items')
          .update({ status: 'needs_reconnect', status_detail: plaidErrorCode(e) })
          .eq('id', item.id)
        brokenNow++
        continue
      }
      throw e
    }
  }

  return NextResponse.json({
    ok: true,
    banks: items?.length ?? 0,
    added,
    modified,
    removed,
    brokenNow,
    skipped,
  })
}
```

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

  // Best-effort at Plaid: if the item is already gone there, still delete it locally.
  try {
    await plaidClient.itemRemove({ access_token: decrypt(item.access_token_encrypted) })
  } catch {
    // fall through to local delete
  }

  const { error } = await supabaseAdmin.from('plaid_items').delete().eq('id', item.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 400 })

  return NextResponse.json({ ok: true })
}
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

  async function disconnect(item: ItemSummary) {
    setBusy(true)
    await fetch('/api/plaid/remove-item', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId: item.id }),
    })
    setBusy(false)
    setPendingRemove(null)
    router.refresh()
  }

  if (items.length === 0) {
    return <p className="text-sm text-muted">No banks connected yet.</p>
  }

  return (
    <>
      <ul className="divide-y divide-line">
        {items.map((item) => (
          <li key={item.id} className="flex items-center justify-between py-3">
            <div>
              <p className="text-sm font-medium text-ink">
                {item.institution_name ?? 'Linked bank'}
              </p>
              {item.status === 'needs_reconnect' ? (
                <p className="text-xs text-coral">Connection lost — reconnect to resume syncing.</p>
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
// Deletes ALL linked banks and their data, so the app can be re-linked against real banks.
// Deleting plaid_items cascades to accounts (002) and, via the 010 FK, to transactions.
// KEEPS households, memberships, categories, budgets, and goals.
// Usage: node --env-file=.env.local scripts/reset-plaid-data.mjs --confirm
import { createClient } from '@supabase/supabase-js'

if (!process.argv.includes('--confirm')) {
  console.error(
    'Refusing to run without --confirm. This deletes ALL linked banks and their transactions.'
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

const { data: items, error: readErr } = await admin.from('plaid_items').select('id')
if (readErr) {
  console.error('Could not read plaid_items:', readErr.message)
  process.exit(1)
}

// Supabase requires a filter on delete; this matches every row.
const { error } = await admin
  .from('plaid_items')
  .delete()
  .neq('id', '00000000-0000-0000-0000-000000000000')
if (error) {
  console.error('Delete failed:', error.message)
  process.exit(1)
}

console.log(
  `✓ Removed ${items?.length ?? 0} linked bank(s); their accounts and transactions cascaded away. Households, categories, budgets, and goals kept.`
)
```

- [ ] **Step 2: Create the go-live runbook**

Create `docs/plaid-production-cutover.md`:

```markdown
# Going live on real bank data — cutover runbook

Do these in order. Everything before step 4 is reversible; step 4 onward touches real money.

1. **Ship the code.** Merge `feature/plaid-production` to `main` (Vercel auto-deploys).
2. **Apply the migration.** Run `db/migrations/010_plaid_production.sql` against the production
   Supabase project. Verify the three new columns and the `transactions_account_id_fkey`
   constraint exist (query in Task 1). *(The spec worried the FK couldn't be added before the
   sandbox reset because of orphaned rows. It can: no orphans exist yet — the disconnect feature
   that creates them is brand new — and the migration's defensive delete covers the case anyway.
   Migrating first is cleaner: the reset in step 3 then cascades transactions away automatically.)*
3. **Purge the sandbox data.** With production Supabase credentials in `.env.local`:
   `node --env-file=.env.local scripts/reset-plaid-data.mjs --confirm`
   This removes the fake banks; it keeps categories, budgets, and goals.
4. **Set production env on Vercel (production scope only):**
   - `PLAID_ENV=production`
   - `PLAID_CLIENT_ID` / `PLAID_SECRET` = the **production** credentials
   - `PLAID_REDIRECT_URI=https://every-dollar-counts.vercel.app/plaid/oauth`
   - Leave `TOKEN_ENCRYPTION_KEY` unchanged.
   - Local dev and Preview keep `PLAID_ENV=sandbox`.
5. **Register the redirect URI** `https://every-dollar-counts.vercel.app/plaid/oauth` in the
   Plaid dashboard (and set the app display name to "Every Dollar Counts").
6. **Link one real bank** on the live site. Confirm its transactions are yours, its balance
   matches the bank's own website, and Refresh pulls new activity.
7. **Link the rest** — brokerage (balances only) and credit cards. Confirm net worth against a
   number you already know to be true.

Prerequisite running in parallel: the Plaid Production application (see
`docs/plaid-production-application.md`). Steps 6–7 need it approved; steps 1–3 do not.
```

- [ ] **Step 3: Verify the guard and dry-run the script (sandbox DB)**

Run without the flag: `node --env-file=.env.local scripts/reset-plaid-data.mjs`
Expected: exits non-zero with the "Refusing to run without --confirm" message, deletes nothing.

Then, **only against a sandbox project you're willing to clear**, run with `--confirm` and verify it reports the count and that `plaid_items` is empty afterward.

- [ ] **Step 4: Commit**

```bash
git add scripts/reset-plaid-data.mjs docs/plaid-production-cutover.md
git commit -m "feat: guarded sandbox reset script and production cutover runbook"
```

---

## Final verification

- [ ] `npx vitest run` — all unit tests pass (including the two new helper suites).
- [ ] `npx tsc --noEmit && npm run lint && npm run build && npm run check:secrets` — all clean.
- [ ] The manual sandbox exercises in Tasks 5, 6, 7, 8 have all been performed successfully.
- [ ] Open a PR from `feature/plaid-production` (PR #16 already tracks the docs; this adds the code). Do **not** merge or run the cutover runbook until the Plaid Production application is approved.
```
