# Haus Milne Budget — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Mint-style, mobile-friendly household budget web app for two people that securely auto-syncs bank data via Plaid, enforces database-level household isolation, and covers dashboard, transactions, budgets, trends, and savings goals.

**Architecture:** A single Next.js (App Router) app deployed on Vercel. Supabase provides magic-link auth and a Postgres database whose Row-Level Security (RLS) makes every row readable only by members of its household. Plaid is called **only** from server-side Route Handlers; bank credentials are entered on Plaid's own screen and the long-lived `access_token` is encrypted at rest and never sent to the browser. Build and test entirely on Plaid **Sandbox** (free, fake banks); flip to Production at the end.

**Tech Stack:** Next.js 16 (App Router, TypeScript, Tailwind) · React 19 · `@supabase/ssr` + `@supabase/supabase-js` · `plaid` (server) + `react-plaid-link` (client) · `recharts` (charts) · Vitest + Testing Library (unit) · Playwright (E2E) · Node `crypto` (AES-256-GCM token encryption).

---

## Global Constraints

_Every task's requirements implicitly include this section. Values verified against official docs on 2026-07-10._

- **Next.js:** whatever `create-next-app@latest` installs (16.2.10 was current on 2026-07-10). Next 16 renames `middleware.ts` → **`proxy.ts`** (exported function `proxy`). If the installed version is `< 16`, use `middleware.ts` / `middleware()` instead — otherwise the file is ignored silently.
- **Supabase env var names are mid-transition.** This plan uses the current names `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (`sb_publishable_…`), and `SUPABASE_SERVICE_ROLE_KEY` (`sb_secret_…`). **Check your Supabase project's API-settings page and use the exact names it issues** — older projects issue `NEXT_PUBLIC_SUPABASE_ANON_KEY` + `SUPABASE_SERVICE_ROLE_KEY`. Pick one set and be consistent.
- **Secret hygiene (hard rule):** anything without the `NEXT_PUBLIC_` prefix must stay server-only. `PLAID_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, and `TOKEN_ENCRYPTION_KEY` **must never** be `NEXT_PUBLIC_`-prefixed and must never be imported into a Client Component. `.env*` is gitignored by default — keep it that way; commit only `.env.example`.
- **Auth check rule:** server-side auth gates always use `supabase.auth.getUser()` (revalidates with Supabase), **never** `getSession()` (trusts the cookie).
- **Plaid access token rule:** only the short-lived `link_token` and the temporary `public_token` may cross the client↔server boundary. The `access_token`/`item_id` are stored encrypted server-side only.
- **Category source of truth:** Plaid's `personal_finance_category` (PFC). Group/label by the 16 stable **primary** values; never hardcode `.detailed` sub-values. Do not use the legacy `category`/`category_id` fields.
- **Package pins:** run `npm view plaid version` and `npm view react-plaid-link version` before pinning (their npm pages block automated fetchers, so exact latest is confirmed at install time, not here).
- **Discipline:** DRY, YAGNI, strict TDD (write the failing test first), commit after every green task.

## Decisions needed from Sarah (resolve before Phase 5; sensible defaults chosen so building can start now)

1. **Chart library** — default `recharts`. Fine to swap for design taste; it's the only UI dependency not otherwise dictated. _(Phase 3)_
2. **Token encryption mechanism** — default: app-level **AES-256-GCM** using a `TOKEN_ENCRYPTION_KEY` env secret (implemented in `lib/crypto.ts`). Alternative: Supabase Vault/pgsodium. _(Phase 2)_
3. **Balance freshness** — default: cached balances via `accountsGet` (updated ~daily, free). Live balances (`accountsBalanceGet`) are billed per request in Production. _(Phase 2)_
4. **Refresh cadence** — default: manual "Refresh" button + an optional Vercel Cron poll. Real-time webhooks deferred. _(Phase 5)_
5. **Plaid production plan/cost** — Transactions is a paid monthly-per-Item subscription in Production; new US/CA teams get a free trial capped at 10 Items. Confirm the plan before flipping to live banks. _(Phase 5)_
6. **Disconnect semantics** — default: "Disconnect bank" calls Plaid `/item/remove` **and** deletes local rows, so access is revoked at Plaid too. _(Phase 2/5)_

## Code convention in this plan

Load-bearing code (Supabase clients, the auth proxy, RLS SQL, all Plaid calls, sync loop, encryption, and every test) is given **in full and verbatim** — get it exactly right. Presentational pages/components are given as **concrete skeletons with an explicit data contract**; their correctness is proven by the Playwright E2E test named in the task, not by unit tests (Vitest cannot render async Server Components).

---

## File Structure

```
haus-milne-budget/
  app/
    layout.tsx  page.tsx  globals.css
    login/page.tsx                         # magic-link form (Client Component)
    auth/confirm/route.ts                  # verifyOtp -> session
    auth/auth-code-error/page.tsx
    (app)/                                 # authenticated segment
      layout.tsx                           # server getUser() guard + nav + household context
      dashboard/page.tsx  transactions/page.tsx  budgets/page.tsx
      trends/page.tsx  goals/page.tsx  settings/page.tsx
    api/
      plaid/{create-link-token,exchange-public-token,sync-transactions,accounts,disconnect}/route.ts
      household/invite/route.ts
      transactions/categorize/route.ts
      budgets/route.ts   goals/route.ts
  components/
    LinkButton.tsx AccountCard.tsx TransactionRow.tsx CategoryPicker.tsx
    BudgetProgressBar.tsx SpendByCategoryChart.tsx MonthOverMonthChart.tsx
    GoalCard.tsx InvitePartnerForm.tsx
  lib/
    supabase/{client,server,admin}.ts
    plaid.ts crypto.ts sync.ts budget.ts categories.ts effective-category.ts
  proxy.ts                                 # Next 16 session refresh + route guard
  db/migrations/
    001_households_memberships.sql  002_plaid_items_accounts.sql  003_transactions.sql
    004_budgets.sql  005_goals.sql  006_rls_policies.sql
  tests/
    unit/{budget,effective-category,categories,sync,crypto}.test.ts
    e2e/{auth,connect-bank}.spec.ts
    rls/household-isolation.test.ts
  vitest.config.mts  playwright.config.ts  next.config.ts
  .env.local (gitignored)  .env.example (committed)  package.json  tsconfig.json
```

---

## Phase 0 — Prerequisites (accounts & secrets)

**One-time setup.** No code deliverable; unblocks everything after it. Do this yourself (Sarah) or with the engineer.

- [ ] **Create a Supabase project** at supabase.com → New project. From Project Settings → API, copy the Project URL, the **publishable/anon** key, and the **secret/service-role** key. In Authentication → Providers → Email, enable Email and **turn OFF "Allow new users to sign up"** (invite-only). In Authentication → URL Configuration, add `http://localhost:3000` and (later) the Vercel URL to redirect allowlist.
- [ ] **Create a Plaid account** at dashboard.plaid.com → get **Sandbox** `client_id` and `secret` (Team Settings → Keys). No cost, no approval for Sandbox.
- [ ] **Generate a token-encryption key:** run `openssl rand -hex 32` and save the output as `TOKEN_ENCRYPTION_KEY`.
- [ ] **Have the GitHub repo ready** (`smilne3/every-dollar-counts`, already exists) and a **Vercel account** connected to it (Phase 1 wires deploy).

---

## Phase 1 — Skeleton + login + household

**Goal:** A deployable app on Vercel where an invited person logs in via magic link, a household + membership exist, and RLS provably isolates households. **Phase gate:** the RLS-isolation test passes and an unauthenticated hit to `/dashboard` redirects to `/login`.

### Task 1.1: Scaffold app + secret hygiene

**Files:** Create `package.json`, `next.config.ts`, `tsconfig.json`, `.gitignore`, `.env.example`, `.env.local`
**Interfaces:** Produces: the Next.js app skeleton, the `@/*` import alias, and all env var names later tasks read.

- [ ] **Step 1 — Scaffold** (run in the repo root; if the tool wants a subdir, scaffold into `.`):

```bash
npx create-next-app@latest . \
  --typescript --tailwind --eslint --app --import-alias "@/*" --use-npm --yes
```

- [ ] **Step 2 — Write `.env.example`** (committed; no real values):

```bash
NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_xxx
SUPABASE_SERVICE_ROLE_KEY=sb_secret_xxx        # server-only, NEVER NEXT_PUBLIC_
PLAID_CLIENT_ID=xxx
PLAID_SECRET=xxx                                # server-only
PLAID_ENV=sandbox
TOKEN_ENCRYPTION_KEY=32_byte_hex                # from: openssl rand -hex 32
```

- [ ] **Step 3 — Copy to `.env.local`** and fill with the real Phase 0 values. Confirm `.gitignore` contains `.env*` (create-next-app adds it).
- [ ] **Step 4 — Guard test** (add to `package.json` scripts): `"check:secrets": "! grep -rE 'NEXT_PUBLIC_(PLAID_SECRET|SUPABASE_SERVICE_ROLE_KEY|TOKEN_ENCRYPTION_KEY)' .env* app lib || (echo LEAK && exit 1)"`
- [ ] **Step 5 — Verify build:** `npm run build` → Expected: succeeds. Run `npm run check:secrets` → Expected: no leak.
- [ ] **Step 6 — Commit:** `git add -A && git commit -m "chore: scaffold Next.js app + env hygiene"`

### Task 1.2: Supabase clients (browser, server, admin)

**Files:** Create `lib/supabase/client.ts`, `lib/supabase/server.ts`, `lib/supabase/admin.ts`
**Interfaces:** Produces `createClient()` (browser + server variants) and `supabaseAdmin`. Consumed by every route/page.

- [ ] **Step 1 — Install:** `npm install @supabase/supabase-js @supabase/ssr server-only`
- [ ] **Step 2 — Write `lib/supabase/client.ts`:**

```ts
import { createBrowserClient } from '@supabase/ssr'
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!
  )
}
```

- [ ] **Step 3 — Write `lib/supabase/server.ts`:**

```ts
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
export async function createClient() {
  const cookieStore = await cookies()
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    { cookies: {
        getAll() { return cookieStore.getAll() },
        setAll(cookiesToSet) {
          try { cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options)) }
          catch { /* called from a Server Component; the proxy refreshes sessions */ }
        },
    } }
  )
}
```

- [ ] **Step 4 — Write `lib/supabase/admin.ts`** (service_role bypasses RLS — server-only):

```ts
import 'server-only'
import { createClient } from '@supabase/supabase-js'
export const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)
```

- [ ] **Step 5 — Verify:** `npx tsc --noEmit` → Expected: no type errors.
- [ ] **Step 6 — Commit:** `git commit -am "feat: supabase browser/server/admin clients"`

### Task 1.3: Session-refresh proxy + route guard

**Files:** Create `proxy.ts` (repo root)
**Interfaces:** Consumes the Supabase env vars. Produces the auth redirect behavior all authed routes rely on.

- [ ] **Step 1 — Write the failing E2E** `tests/e2e/auth.spec.ts` (guard portion):

```ts
import { test, expect } from '@playwright/test'
test('unauthenticated /dashboard redirects to /login', async ({ page }) => {
  await page.goto('/dashboard')
  await expect(page).toHaveURL(/\/login/)
})
```

- [ ] **Step 2 — Write `proxy.ts`** (⚠ no code between `createServerClient` and `getUser()`):

```ts
import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
export async function proxy(request: NextRequest) {
  let res = NextResponse.next({ request })
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    { cookies: {
        getAll() { return request.cookies.getAll() },
        setAll(list) {
          list.forEach(({ name, value }) => request.cookies.set(name, value))
          res = NextResponse.next({ request })
          list.forEach(({ name, value, options }) => res.cookies.set(name, value, options))
        },
    } }
  )
  const { data: { user } } = await supabase.auth.getUser()
  if (!user && !request.nextUrl.pathname.startsWith('/login') && !request.nextUrl.pathname.startsWith('/auth')) {
    const url = request.nextUrl.clone(); url.pathname = '/login'
    return NextResponse.redirect(url)
  }
  return res
}
export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] }
```

- [ ] **Step 3 — Run E2E** (after Playwright is set up in Task 1.4/Testing): `npx playwright test auth` → Expected: PASS. _(If run before login page exists, it still passes: the redirect is what's asserted.)_
- [ ] **Step 4 — Commit:** `git commit -am "feat: session-refresh proxy + auth route guard"`

### Task 1.4: Magic-link login + confirm route (invite-only)

**Files:** Create `app/login/page.tsx`, `app/auth/confirm/route.ts`, `app/auth/auth-code-error/page.tsx`
**Interfaces:** Consumes `lib/supabase/*`. Produces the `/auth/confirm` callback other flows redirect to.

- [ ] **Step 1 — Write `app/login/page.tsx`** (Client Component; `shouldCreateUser:false` enforces invite-only):

```tsx
'use client'
import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
export default function Login() {
  const [email, setEmail] = useState(''); const [sent, setSent] = useState(false); const [err, setErr] = useState('')
  async function send(e: React.FormEvent) {
    e.preventDefault(); setErr('')
    const supabase = createClient()
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${location.origin}/auth/confirm`, shouldCreateUser: false },
    })
    error ? setErr('That email is not invited to a household.') : setSent(true)
  }
  if (sent) return <p className="p-8">Check your email for a login link.</p>
  return (
    <form onSubmit={send} className="mx-auto mt-24 flex max-w-sm flex-col gap-3 p-6">
      <h1 className="text-xl font-semibold">Haus Milne Budget</h1>
      <input className="rounded border p-2" type="email" required placeholder="you@email.com"
        value={email} onChange={e => setEmail(e.target.value)} />
      <button className="rounded bg-black p-2 text-white">Email me a login link</button>
      {err && <p className="text-sm text-red-600">{err}</p>}
    </form>
  )
}
```

- [ ] **Step 2 — Write `app/auth/confirm/route.ts`:**

```ts
import { type EmailOtpType } from '@supabase/supabase-js'
import { type NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const token_hash = searchParams.get('token_hash')
  const type = searchParams.get('type') as EmailOtpType | null
  const next = searchParams.get('next') ?? '/dashboard'
  if (token_hash && type) {
    const supabase = await createClient()
    const { error } = await supabase.auth.verifyOtp({ type, token_hash })
    if (!error) return NextResponse.redirect(new URL(next, request.url))
  }
  return NextResponse.redirect(new URL('/auth/auth-code-error', request.url))
}
```

- [ ] **Step 3 — Write `app/auth/auth-code-error/page.tsx`** (simple: `<p>That link was invalid or expired. Try again.</p>`).
- [ ] **Step 4 — E2E** `tests/e2e/auth.spec.ts` (add): invited email → link → lands on `/dashboard`; non-invited email → error message shown. _(Requires a seeded invited user; use the Supabase test project from the Testing setup. In CI the magic-link email can be read via Supabase's Inbucket/test inbox or a signInWithPassword shortcut for the seeded user.)_
- [ ] **Step 5 — Commit:** `git commit -am "feat: invite-only magic-link login + confirm route"`

### Task 1.5: Households + memberships schema + RLS

**Files:** Create `db/migrations/001_households_memberships.sql`, `db/migrations/006_rls_policies.sql`
**Interfaces:** Produces `households`, `memberships`, and `private.household_ids()` — the helper every later RLS policy uses.

- [ ] **Step 1 — Write the failing RLS test** `tests/rls/household-isolation.test.ts` (see Testing setup for the two-client harness). Assert: user B `select` on user A's `households` row returns `[]`.
- [ ] **Step 2 — Write `001_households_memberships.sql`:**

```sql
create schema if not exists private;

create table households ( id uuid primary key default gen_random_uuid(), name text );
create table memberships (
  user_id uuid not null references auth.users(id),
  household_id uuid not null references households(id),
  primary key (user_id, household_id)
);

-- SECURITY DEFINER: runs as owner, bypasses memberships RLS -> no recursion
create or replace function private.household_ids()
returns setof uuid language sql security definer set search_path = '' stable as $$
  select household_id from public.memberships where user_id = auth.uid();
$$;
grant execute on function private.household_ids() to authenticated;
```

- [ ] **Step 3 — Write `006_rls_policies.sql`** (this file grows each phase; start with households + memberships):

```sql
alter table households  enable row level security;
alter table memberships enable row level security;

-- memberships policy references auth.uid() DIRECTLY (never self-selects) -> no recursion
create policy "see your own membership rows" on memberships
  for select to authenticated using ( (select auth.uid()) = user_id );

create policy "read your households" on households
  for select to authenticated using ( id in (select private.household_ids()) );
```

- [ ] **Step 4 — Apply migrations** to the Supabase project (SQL editor or `supabase db push`), then run `npx vitest run tests/rls` → Expected: PASS (B sees none of A's rows; no "infinite recursion" error).
- [ ] **Step 5 — Commit:** `git commit -am "feat: households/memberships schema + non-recursive RLS"`

### Task 1.6: Partner invite route

**Files:** Create `app/api/household/invite/route.ts`, `components/InvitePartnerForm.tsx`
**Interfaces:** Consumes `supabaseAdmin`, `createClient` (server). Produces the invite flow used from Settings.

- [ ] **Step 1 — Write the failing integration test:** posting to the invite route as a household member calls `inviteUserByEmail` and inserts a `memberships` row; a non-member caller is rejected 403. _(Mock `supabaseAdmin.auth.admin.inviteUserByEmail` with `vi.mock`.)_
- [ ] **Step 2 — Write `app/api/household/invite/route.ts`:**

```ts
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
export async function POST(req: Request) {
  const { email, household_id } = await req.json()
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  // verify caller belongs to household_id (RLS-scoped read)
  const { data: mine } = await supabase.from('memberships').select('household_id').eq('household_id', household_id)
  if (!mine?.length) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const { data, error } = await supabaseAdmin.auth.admin.inviteUserByEmail(email)
  if (error) return NextResponse.json({ error: error.message }, { status: 400 })
  await supabaseAdmin.from('memberships').insert({ user_id: data.user.id, household_id })
  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 3 — Write `components/InvitePartnerForm.tsx`** (Client Component: email input → `POST /api/household/invite`).
- [ ] **Step 4 — Run test:** `npx vitest run tests/unit` (invite test) → Expected: PASS.
- [ ] **Step 5 — Commit:** `git commit -am "feat: partner invite route + form"`

### Task 1.7: Authenticated shell + first deploy

**Files:** Create `app/(app)/layout.tsx`, minimal `app/(app)/dashboard/page.tsx`, `app/page.tsx`
**Interfaces:** Consumes `createClient` (server). Produces the nav shell + household context for all `(app)` pages.

- [ ] **Step 1 — `app/(app)/layout.tsx`:** server component that calls `const { data: { user } } = await (await createClient()).auth.getUser()`, redirects to `/login` if absent, loads the user's household, renders nav (Dashboard · Transactions · Budgets · Trends · Goals · Settings) + `{children}`.
- [ ] **Step 2 — `app/page.tsx`:** redirect to `/dashboard`. Minimal `dashboard/page.tsx`: `<h1>Dashboard</h1>` placeholder (filled in Phase 2).
- [ ] **Step 3 — Deploy:** connect the repo in Vercel; add all `.env.local` values in Vercel → Settings → Environment Variables (Production + Preview + Development). Push the branch; confirm the preview deploy builds.
- [ ] **Step 4 — Verify:** visit the preview URL `/dashboard` while logged out → redirected to `/login`. Log in with an invited email → reach `/dashboard`.
- [ ] **Step 5 — Commit:** `git commit -am "feat: authed app shell + Vercel deploy"`

---

## Phase 2 — Connect bank (Sandbox) + Dashboard + Transactions

**Goal:** Link a Plaid Sandbox bank, store the `access_token` encrypted server-side, sync transactions by cursor, and render household-scoped Dashboard + searchable, re-categorizable Transactions. **Phase gate:** E2E connects a sandbox bank and transactions appear; re-categorizing persists; the `access_token` never appears in any browser payload.

### Task 2.1: Plaid client + token encryption

**Files:** Create `lib/plaid.ts`, `lib/crypto.ts`, `tests/unit/crypto.test.ts`
**Interfaces:** Produces `plaidClient`, `encrypt(s)`, `decrypt(s)`.

- [ ] **Step 1 — Install:** `npm install plaid react-plaid-link` (pin per Global Constraints).
- [ ] **Step 2 — Write failing `tests/unit/crypto.test.ts`:**

```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { encrypt, decrypt } from '@/lib/crypto'
beforeAll(() => { process.env.TOKEN_ENCRYPTION_KEY = '0'.repeat(64) }) // 32 bytes hex
describe('crypto', () => {
  it('round-trips', () => {
    const secret = 'access-sandbox-abc123'
    expect(decrypt(encrypt(secret))).toBe(secret)
  })
  it('produces different ciphertext each call (random IV)', () => {
    expect(encrypt('x')).not.toBe(encrypt('x'))
  })
})
```

- [ ] **Step 3 — Run:** `npx vitest run tests/unit/crypto.test.ts` → Expected: FAIL (module not found).
- [ ] **Step 4 — Write `lib/crypto.ts`** (AES-256-GCM):

```ts
import 'server-only'
import crypto from 'node:crypto'
function key() { return Buffer.from(process.env.TOKEN_ENCRYPTION_KEY!, 'hex') }
export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv)
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return [iv.toString('hex'), c.getAuthTag().toString('hex'), enc.toString('hex')].join(':')
}
export function decrypt(payload: string): string {
  const [iv, tag, data] = payload.split(':')
  const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'hex'))
  d.setAuthTag(Buffer.from(tag, 'hex'))
  return Buffer.concat([d.update(Buffer.from(data, 'hex')), d.final()]).toString('utf8')
}
```

- [ ] **Step 5 — Write `lib/plaid.ts`:**

```ts
import 'server-only'
import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid'
const configuration = new Configuration({
  basePath: process.env.PLAID_ENV === 'production' ? PlaidEnvironments.production : PlaidEnvironments.sandbox,
  baseOptions: { headers: {
    'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID!,
    'PLAID-SECRET': process.env.PLAID_SECRET!,
    'Plaid-Version': '2020-09-14',
  } },
})
export const plaidClient = new PlaidApi(configuration)
```

- [ ] **Step 6 — Run:** `npx vitest run tests/unit/crypto.test.ts` → Expected: PASS. Commit: `git commit -am "feat: server Plaid client + AES-256-GCM token crypto"`

### Task 2.2: Plaid item/account schema + RLS

**Files:** Create `db/migrations/002_plaid_items_accounts.sql`; append to `006_rls_policies.sql`
**Interfaces:** Produces `plaid_items` (encrypted token + cursor) and `accounts`.

- [ ] **Step 1 — Extend the RLS-isolation test** to cover `plaid_items` and `accounts` (B cannot read A's).
- [ ] **Step 2 — Write `002_plaid_items_accounts.sql`:**

```sql
create table plaid_items (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id),
  item_id text not null unique,
  access_token_encrypted text not null,     -- never sent to browser
  cursor text,                              -- transactions/sync next_cursor
  institution_name text,
  created_at timestamptz default now()
);
create table accounts (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id),
  plaid_item_id uuid not null references plaid_items(id) on delete cascade,
  account_id text not null unique,
  name text, type text, subtype text,
  current_balance numeric, available_balance numeric, iso_currency_code text
);
```

- [ ] **Step 3 — Append RLS to `006_rls_policies.sql`** (read-only for clients; ingest routes write via `supabaseAdmin`):

```sql
alter table plaid_items enable row level security;
alter table accounts    enable row level security;
create policy "read your items"    on plaid_items for select to authenticated using ( household_id in (select private.household_ids()) );
create policy "read your accounts" on accounts    for select to authenticated using ( household_id in (select private.household_ids()) );
-- NOTE: no client SELECT exposes access_token_encrypted directly; dashboards select explicit columns only.
```

- [ ] **Step 4 — Apply + run RLS test:** `npx vitest run tests/rls` → Expected: PASS. Commit.

### Task 2.3: create-link-token + exchange-public-token + LinkButton

**Files:** Create `app/api/plaid/create-link-token/route.ts`, `app/api/plaid/exchange-public-token/route.ts`, `components/LinkButton.tsx`
**Interfaces:** Consumes `plaidClient`, `encrypt`, `supabaseAdmin`, `createClient`. Produces a stored, encrypted `plaid_items` row.

- [ ] **Step 1 — `create-link-token/route.ts`:**

```ts
import { NextResponse } from 'next/server'
import { plaidClient } from '@/lib/plaid'
import { createClient } from '@/lib/supabase/server'
export async function POST() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const r = await plaidClient.linkTokenCreate({
    user: { client_user_id: user.id },
    client_name: 'Haus Milne Budget',
    products: ['transactions'],
    language: 'en',
    country_codes: ['US'],
  })
  return NextResponse.json({ link_token: r.data.link_token })
}
```

- [ ] **Step 2 — `components/LinkButton.tsx`:**

```tsx
'use client'
import { useEffect, useState } from 'react'
import { usePlaidLink } from 'react-plaid-link'
export function LinkButton() {
  const [linkToken, setLinkToken] = useState<string | null>(null)
  useEffect(() => { fetch('/api/plaid/create-link-token', { method: 'POST' })
    .then(r => r.json()).then(d => setLinkToken(d.link_token)) }, [])
  const { open, ready } = usePlaidLink({
    token: linkToken,
    onSuccess: (public_token) => fetch('/api/plaid/exchange-public-token', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ public_token }),
    }).then(() => location.reload()),
  })
  return <button onClick={() => open()} disabled={!ready || !linkToken}
    className="rounded bg-black px-4 py-2 text-white">Connect a bank</button>
}
```

- [ ] **Step 3 — `exchange-public-token/route.ts`** (exchange server-side; store encrypted; fetch accounts):

```ts
import { NextResponse } from 'next/server'
import { plaidClient } from '@/lib/plaid'
import { encrypt } from '@/lib/crypto'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
export async function POST(req: Request) {
  const { public_token } = await req.json()
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const { data: m } = await supabase.from('memberships').select('household_id').limit(1).single()
  const household_id = m!.household_id
  const { data } = await plaidClient.itemPublicTokenExchange({ public_token })
  const accessToken = data.access_token
  const { data: item } = await supabaseAdmin.from('plaid_items').insert({
    household_id, item_id: data.item_id, access_token_encrypted: encrypt(accessToken),
  }).select('id').single()
  const acc = await plaidClient.accountsGet({ access_token: accessToken })
  await supabaseAdmin.from('accounts').insert(acc.data.accounts.map(a => ({
    household_id, plaid_item_id: item!.id, account_id: a.account_id, name: a.name,
    type: a.type, subtype: a.subtype ?? null,
    current_balance: a.balances.current, available_balance: a.balances.available,
    iso_currency_code: a.balances.iso_currency_code,
  })))
  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 4 — Write failing E2E** `tests/e2e/connect-bank.spec.ts`: rather than drive the Plaid iframe, the test seeds an item via `/sandbox/public_token/create` (institution `ins_109508`) then exchanges it, and asserts the dashboard shows an account and that no network response body contains `access-sandbox`. _(Manual smoke: real Link iframe with `user_good`/`pass_good`, OTP `1234`.)_
- [ ] **Step 5 — Run E2E** against the built app → Expected: PASS. Commit.

### Task 2.4: Cursor-based transaction sync + schema

**Files:** Create `lib/sync.ts`, `app/api/plaid/sync-transactions/route.ts`, `db/migrations/003_transactions.sql`, `tests/unit/sync.test.ts`
**Interfaces:** Produces `syncItem(access_token, cursor)` returning `{ added, modified, removed, next_cursor }` (drained).

- [ ] **Step 1 — Write failing `tests/unit/sync.test.ts`** (mock `plaid`): two pages (`has_more:true` then `false`); assert it concatenates all `added` and returns the **final** `next_cursor` only after the loop ends.

```ts
import { describe, it, expect, vi } from 'vitest'
vi.mock('@/lib/plaid', () => ({ plaidClient: { transactionsSync: vi.fn()
  .mockResolvedValueOnce({ data: { added: [{ id: 1 }], modified: [], removed: [], has_more: true,  next_cursor: 'c1' } })
  .mockResolvedValueOnce({ data: { added: [{ id: 2 }], modified: [], removed: [], has_more: false, next_cursor: 'c2' } }) } }))
import { syncItem } from '@/lib/sync'
describe('syncItem', () => {
  it('drains pages and returns final cursor', async () => {
    const r = await syncItem('access-sandbox-x', undefined)
    expect(r.added).toHaveLength(2)
    expect(r.next_cursor).toBe('c2')
  })
})
```

- [ ] **Step 2 — Write `lib/sync.ts`:**

```ts
import { plaidClient } from '@/lib/plaid'
export async function syncItem(access_token: string, cursor?: string) {
  let added: any[] = [], modified: any[] = [], removed: any[] = [], hasMore = true
  let next = cursor
  while (hasMore) {
    const { data } = await plaidClient.transactionsSync({ access_token, cursor: next })
    added = added.concat(data.added); modified = modified.concat(data.modified); removed = removed.concat(data.removed)
    hasMore = data.has_more; next = data.next_cursor
  }
  return { added, modified, removed, next_cursor: next }
}
```

- [ ] **Step 3 — Write `003_transactions.sql`:**

```sql
create table transactions (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id),
  account_id text not null,
  plaid_transaction_id text not null unique,
  amount numeric not null,
  date date not null,
  name text, merchant_name text,
  pfc_primary text, pfc_detailed text, pfc_confidence text,
  user_category text,                        -- nullable override
  removed boolean default false
);
```
Append to `006_rls_policies.sql`:
```sql
alter table transactions enable row level security;
create policy "read your txns"     on transactions for select to authenticated using ( household_id in (select private.household_ids()) );
create policy "update your txns"   on transactions for update to authenticated using ( household_id in (select private.household_ids()) ) with check ( household_id in (select private.household_ids()) );
```

- [ ] **Step 4 — Write `sync-transactions/route.ts`:** for each of the household's `plaid_items`, `decrypt` the token, call `syncItem`, upsert rows (`onConflict: plaid_transaction_id`) mapping `personal_finance_category.primary/detailed/confidence_level` → `pfc_*`, mark `removed` ones, then persist `next_cursor` back to the item. Writes via `supabaseAdmin`, always setting `household_id`.
- [ ] **Step 5 — Run:** `npx vitest run tests/unit/sync.test.ts` → PASS. Apply migration; run RLS test. Commit.

### Task 2.5: Dashboard + Transactions views + re-categorize

**Files:** Create `app/(app)/dashboard/page.tsx`, `app/api/plaid/accounts/route.ts`, `app/(app)/transactions/page.tsx`, `app/api/transactions/categorize/route.ts`, `lib/effective-category.ts`, `lib/categories.ts`, `components/{AccountCard,TransactionRow,CategoryPicker}.tsx`, `tests/unit/effective-category.test.ts`, `tests/unit/categories.test.ts`
**Interfaces:** Produces `effectiveCategory(t)`, the category display map, and the two main screens.

- [ ] **Step 1 — Write failing `tests/unit/effective-category.test.ts`:**

```ts
import { describe, it, expect } from 'vitest'
import { effectiveCategory } from '@/lib/effective-category'
describe('effectiveCategory', () => {
  it('prefers user override', () => expect(effectiveCategory({ user_category: 'TRAVEL', pfc_primary: 'FOOD_AND_DRINK' })).toBe('TRAVEL'))
  it('falls back to pfc_primary', () => expect(effectiveCategory({ user_category: null, pfc_primary: 'MEDICAL' })).toBe('MEDICAL'))
})
```

- [ ] **Step 2 — Write `lib/effective-category.ts`:**

```ts
export function effectiveCategory(t: { user_category: string | null; pfc_primary: string | null }) {
  return t.user_category ?? t.pfc_primary ?? 'GENERAL_MERCHANDISE'
}
```

- [ ] **Step 3 — Write `lib/categories.ts`** (PFC primary → friendly label; the 16 stable primaries) and `tests/unit/categories.test.ts` asserting e.g. `label('FOOD_AND_DRINK') === 'Food & Drink'` and that all 16 primaries have labels.

```ts
export const CATEGORY_LABELS: Record<string, string> = {
  INCOME: 'Income', TRANSFER_IN: 'Transfer In', TRANSFER_OUT: 'Transfer Out',
  LOAN_PAYMENTS: 'Loan Payments', BANK_FEES: 'Bank Fees', ENTERTAINMENT: 'Entertainment',
  FOOD_AND_DRINK: 'Food & Drink', GENERAL_MERCHANDISE: 'Shopping', HOME_IMPROVEMENT: 'Home',
  MEDICAL: 'Medical', PERSONAL_CARE: 'Personal Care', GENERAL_SERVICES: 'Services',
  GOVERNMENT_AND_NON_PROFIT: 'Government & Nonprofit', TRANSPORTATION: 'Transportation',
  TRAVEL: 'Travel', RENT_AND_UTILITIES: 'Rent & Utilities',
}
export const CATEGORIES = Object.keys(CATEGORY_LABELS)
export const label = (c: string) => CATEGORY_LABELS[c] ?? c
```

- [ ] **Step 4 — `accounts/route.ts`:** GET returns the household's accounts (RLS-scoped select of display columns only — never `access_token_encrypted`). `dashboard/page.tsx`: server component summing balances into a household total + `AccountCard` per account.
- [ ] **Step 5 — `transactions/page.tsx`:** server component listing transactions (search box filters by `name/merchant_name`), each row a `TransactionRow` with a `CategoryPicker` showing `label(effectiveCategory(t))`.
- [ ] **Step 6 — `categorize/route.ts`** (user session, RLS UPDATE policy enforces household scope):

```ts
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
export async function POST(req: Request) {
  const { transactionId, category } = await req.json()
  const supabase = await createClient()
  const { error } = await supabase.from('transactions').update({ user_category: category }).eq('id', transactionId)
  return error ? NextResponse.json({ error: error.message }, { status: 400 }) : NextResponse.json({ ok: true })
}
```

- [ ] **Step 7 — Run:** `npx vitest run tests/unit` → PASS. E2E: dashboard shows accounts + total; searching filters; re-categorizing a transaction persists across reload. Commit.

---

## Phase 3 — Budgets + Trends

**Goal:** Monthly per-category limits with progress bars, and two charts (spending-by-category this month; this month vs last). **Phase gate:** a budget shows correct spent-vs-limit and over-budget flag; charts match the underlying transactions. Grouping is by **effective** category.

### Task 3.1: Budgets schema + CRUD + RLS

**Files:** Create `db/migrations/004_budgets.sql`, `app/api/budgets/route.ts`; append `006_rls_policies.sql`

- [ ] **Step 1 — RLS test:** budgets are household-scoped read/write (extend isolation suite).
- [ ] **Step 2 — `004_budgets.sql`:**

```sql
create table budgets (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id),
  category text not null,        -- PFC primary (effective-category value)
  monthly_limit numeric not null,
  unique (household_id, category)
);
```
Append RLS (`for all` with household check on `using` + `with check`).
- [ ] **Step 3 — `budgets/route.ts`:** GET household budgets; POST/PUT upserts `(household_id, category)` → `monthly_limit` (unit test: upsert replaces prior limit for that category). Commit.

### Task 3.2: Budget math + progress bars

**Files:** Create `lib/budget.ts`, `app/(app)/budgets/page.tsx`, `components/BudgetProgressBar.tsx`, `tests/unit/budget.test.ts`

- [ ] **Step 1 — Failing `tests/unit/budget.test.ts`:** `groupByCategory` sums this-month spend per effective category; `progress(spend, limit)` clamps to `[0,1]` and flags `over` when `spend > limit`.
- [ ] **Step 2 — `lib/budget.ts`:**

```ts
export function groupByCategory(txns: { category: string; amount: number }[]) {
  return txns.reduce<Record<string, number>>((acc, t) => { acc[t.category] = (acc[t.category] ?? 0) + t.amount; return acc }, {})
}
export function progress(spend: number, limit: number) {
  const ratio = limit > 0 ? spend / limit : 0
  return { ratio: Math.min(Math.max(ratio, 0), 1), over: spend > limit }
}
```

- [ ] **Step 3 — `budgets/page.tsx`** maps each budget to a `BudgetProgressBar` (green→amber→red by ratio; "over budget" when `over`). Run unit tests → PASS. Commit.

### Task 3.3: Trends charts

**Files:** Create `app/(app)/trends/page.tsx`, `components/{SpendByCategoryChart,MonthOverMonthChart}.tsx`; add month-bucketing helper + test

- [ ] **Step 1 — Failing unit test** for month bucketing: a transaction dated in the previous calendar month lands in `lastMonth`, not `thisMonth`. Shape: `{ thisMonth: Record<cat, number>, lastMonth: Record<cat, number> }` split on `date >= startOfMonth(now)` vs `[startOfLastMonth, startOfMonth)`.
- [ ] **Step 2 — Implement the bucketing helper** in `lib/budget.ts` (or `lib/trends.ts`) and the two `recharts` components (`SpendByCategoryChart` = bar by category this month; `MonthOverMonthChart` = grouped bars this vs last).
- [ ] **Step 3 — E2E:** both charts render with seeded sandbox data. Run tests → PASS. Commit.

---

## Phase 4 — Savings goals

**Goal:** Named goals with target + progress, household-scoped. **Phase gate:** create a goal and see an accurate progress bar; RLS scopes goals to the household.

### Task 4.1: Goals schema + CRUD + UI

**Files:** Create `db/migrations/005_goals.sql`, `app/api/goals/route.ts`, `app/(app)/goals/page.tsx`, `components/GoalCard.tsx`; append `006_rls_policies.sql`; add goal-math test

- [ ] **Step 1 — Failing unit test:** `goalProgress(saved, target)` = `saved/target` clamped to `[0,1]` (`target=0` → `0`).
- [ ] **Step 2 — `005_goals.sql`:**

```sql
create table goals (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id),
  name text not null,
  target_amount numeric not null,
  saved_amount numeric not null default 0
);
```
Append RLS (`for all`, household check). Extend RLS-isolation test to `goals`.
- [ ] **Step 3 — `goals/route.ts`** (GET/POST/PUT), `goals/page.tsx` + `GoalCard` (name, `$saved / $target`, progress bar). Run tests → PASS. Commit.

---

## Phase 5 — Go-live checklist

**Goal:** Prove the security posture, then flip Plaid Sandbox → Production. **Phase gate:** full RLS-isolation suite green across **all** tables; secret-leak grep clean; a Production smoke test links + syncs a real bank.

### Task 5.1: Security review pass

**Files:** review `proxy.ts`, `lib/supabase/admin.ts`, `lib/plaid.ts`, `db/migrations/006_rls_policies.sql`

- [ ] **Step 1 — Run the full RLS-isolation suite** across `households, memberships, plaid_items, accounts, transactions, budgets, goals` → Expected: every table denies cross-household reads/writes; no recursion errors.
- [ ] **Step 2 — Assertions checklist** (each must hold):
  - `getUser()` (not `getSession`) gates every server auth check.
  - `access_token` is only ever stored encrypted; grep all API responses/logs for `access-sandbox`/`access-production` → none.
  - Public signups disabled in Supabase Auth config (belt-and-braces with `shouldCreateUser:false`).
  - HTTPS enforced (Vercel default); Plaid `products` is `['transactions']` only (read-only).
  - `SUPABASE_SERVICE_ROLE_KEY` unprefixed and imported only in `lib/supabase/admin.ts` (which imports `server-only`); `PLAID_SECRET`/`TOKEN_ENCRYPTION_KEY` likewise server-only.
- [ ] **Step 3 — Run:** `npm run check:secrets && npx vitest run tests/rls` → PASS. Commit.

### Task 5.2: Flip Plaid to Production + Vercel env

**Files:** `lib/plaid.ts` (already env-driven), `.env.example`

- [ ] **Step 1 — Apply for Plaid Production** access in the Plaid dashboard; confirm the plan/cost (see Decision 5). `lib/plaid.ts` already switches on `PLAID_ENV`.
- [ ] **Step 2 — Set Vercel env per environment:** Production → `PLAID_ENV=production`, real `PLAID_SECRET`, Supabase prod keys. Preview/CI → `PLAID_ENV=sandbox`. **Env changes apply only to new deployments** — redeploy after changing.
- [ ] **Step 3 — Production smoke test:** link one real bank (small scope), confirm accounts + a sync of recent transactions. Sandbox path stays green for CI. Commit.

### Task 5.3 (optional): Scheduled sync

**Files:** `app/api/plaid/sync-transactions/route.ts` (add a cron-triggered entry), `vercel.json`

- [ ] **Step 1 — Add a Vercel Cron** hitting `/api/plaid/sync-transactions` on a chosen cadence (Decision 4). The per-item stored cursor makes each run incremental. Integration test: a scheduled POST syncs all household items and only new transactions appear. Add the `SYNC_UPDATES_AVAILABLE` webhook later only if near-real-time is wanted. Commit.

---

## Testing setup (do once, early in Phase 1)

**Vitest** — `npm install -D vitest @vitejs/plugin-react jsdom @testing-library/react @testing-library/dom vite-tsconfig-paths`. Create `vitest.config.mts`:

```ts
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tsconfigPaths from 'vite-tsconfig-paths'
export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  test: { environment: 'jsdom' },
})
```
Add `"test": "vitest"` to `package.json`. **Constraint:** Vitest cannot render async Server Components — unit-test only pure functions + synchronous components; everything async is covered by Playwright.

**Playwright** — `npm init playwright`. In `playwright.config.ts` set `use.baseURL: 'http://localhost:3000'` and a `webServer` that runs the **production** build (`npm run build && npm run start`). Do **not** automate the Plaid Link iframe — seed items via Plaid Sandbox `/sandbox/public_token/create` (institution `ins_109508`, First Platypus Bank) then exchange; reserve real-iframe driving (`user_good`/`pass_good`, OTP `1234`) for a single manual smoke check.

**RLS isolation harness** — `tests/rls/household-isolation.test.ts` runs in Node against a **dedicated Supabase test project**. Create two `createClient(url, PUBLISHABLE_KEY)` instances, each with a distinct `auth.storageKey` and `persistSession:false` (avoids session bleed); `signInWithPassword` as user A and user B (seeded with passwords). Seed a row under A's household, then assert **B's** `select` returns `[]`. **Never** use the service-role client for the assertion itself (it bypasses RLS). Application-level, so no transaction rollback — use unique per-run identifiers and don't assume a clean DB.

```ts
import { createClient } from '@supabase/supabase-js'
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!, key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!
const A = createClient(url, key, { auth: { storageKey: 'a', persistSession: false } })
const B = createClient(url, key, { auth: { storageKey: 'b', persistSession: false } })
// beforeAll: A.auth.signInWithPassword(...), B.auth.signInWithPassword(...)
// test: seed under A's household, then expect (await B.from('transactions').select('*')).data to exclude A's row
```

**CI order:** Vitest (every push) → RLS isolation (needs the Supabase test project) → Playwright (needs Plaid sandbox creds). CI uses `PLAID_ENV=sandbox`.

---

## Self-review — spec coverage

- Dashboard/accounts/total → 2.5 · Transactions auto-pulled + categorized + searchable + re-categorizable → 2.4/2.5 · Budgets + progress → 3.1/3.2 · Trends (2 charts) → 3.3 · Savings goals → 4.1 · Settings connect/disconnect + invite → 2.3/1.6 (+ disconnect route per Decision 6).
- Security: bank password only on Plaid's screen (2.3) · token server-side encrypted (2.1/2.3) · household RLS isolation (1.5 + every schema task, verified 5.1) · invite-only (1.4/Phase 0) · HTTPS + read-only (5.1).
- Auth/authz: magic-link (1.4) · household + invite (1.5/1.6) · RLS (throughout).
- Cost/Plaid path: Sandbox throughout; flip in 5.2 (Decision 5).
- All five spec build phases map 1:1 to Phases 1–5.
