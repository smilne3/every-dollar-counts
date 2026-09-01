# Environment Write Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make it impossible for one Plaid environment to write household financial data into a database belonging to another, closing #23 at its single entrance rather than filtering fourteen exits.

**Architecture:** A new single-row `app_env` table records which Plaid environment the database belongs to. A new `lib/app-env.ts` compares it against the app's own `plaidEnv` and throws on mismatch. That assertion is applied at the four places this app writes household financial data. Nothing reads change; no column is added to `accounts` or `transactions`.

**Tech Stack:** Next.js 16 (App Router), TypeScript, Supabase (Postgres + PostgREST), Vitest 4 + jsdom, Plaid Node SDK.

**Spec:** `docs/superpowers/specs/2026-09-01-plaid-env-write-guard-design.md`

## Global Constraints

- **Migrations are applied by hand.** There is no migration runner. Per `README.md:73`, each file in `db/migrations/` is pasted into the Supabase SQL Editor and run in order. **No task in this plan may assume a migration has been applied automatically.**
- **`PLAID_ENV` is only ever `'sandbox'` or `'production'`.** `lib/plaid.ts:9-14` throws at import time on any other value. Never introduce a third environment string.
- **Vitest sets `PLAID_ENV: 'sandbox'` globally** (`vitest.config.ts`). Tests must never be able to reach real banks.
- **`lib/supabase/admin.ts` runs `createClient(...)` at module scope.** Any test importing a module in that chain must `vi.mock('@/lib/supabase/admin', ...)` or it dies with "supabaseUrl is required" before the test body runs.
- **`lib/` stays framework-free.** `lib/app-env.ts` must not import from `next/server`; routes translate its errors into responses themselves.
- **Verification commands:** `npm test`, `npx tsc --noEmit`, `npm run lint`, `npm run check:secrets`. All four are green on `main` today (168 tests, 20 files) and must stay green.
- **Branch:** `fix/23-plaid-env-write-guard`, already created, spec already committed.

---

### Task 1: Read-only contamination check

Confirms the live database has no cross-environment rows before anything is changed. **Read-only — issues no writes.** The spec expects it to find nothing; this proves it rather than assuming it.

**Files:**
- Create: `scripts/check-env-contamination.mjs`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: nothing later tasks import. It is an operational script run by hand.

- [ ] **Step 1: Write the script**

Follows the env-loading and exit-code shape of `scripts/reset-plaid-data.mjs`.

```js
// Reports household financial rows whose environment does not match the environment that owns
// their bank. READ-ONLY: this script issues no writes and no deletes.
//
// accounts and transactions have no plaid_env column of their own (#23) and do not need one --
// their environment is derivable through the existing foreign keys:
//   accounts.plaid_item_id -> plaid_items.plaid_env
//   transactions.account_id -> accounts.account_id -> accounts.plaid_item_id -> plaid_items
//
// Usage: node --env-file=.env.local scripts/check-env-contamination.mjs
import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const svc = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !svc) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.')
  process.exit(1)
}
const admin = createClient(url, svc, { auth: { persistSession: false } })

function die(what, error) {
  console.error(`Could not read ${what}: ${error.message}`)
  process.exit(1)
}

const { data: items, error: itemErr } = await admin
  .from('plaid_items')
  .select('id, plaid_env, institution_name')
if (itemErr) die('plaid_items', itemErr)

const envByItem = new Map(items.map((i) => [i.id, i.plaid_env]))
const envCounts = items.reduce((acc, i) => {
  acc[i.plaid_env] = (acc[i.plaid_env] ?? 0) + 1
  return acc
}, {})

console.log('Linked banks by environment:', envCounts)

const { data: accounts, error: accErr } = await admin
  .from('accounts')
  .select('id, account_id, name, plaid_item_id')
if (accErr) die('accounts', accErr)

// An account whose owning bank row is gone cannot be attributed to any environment at all.
const orphanAccounts = accounts.filter((a) => !envByItem.has(a.plaid_item_id))
const sandboxAccounts = accounts.filter((a) => envByItem.get(a.plaid_item_id) === 'sandbox')

const { count: sandboxTxnCount, error: txnErr } = await admin
  .from('transactions')
  .select('*', { count: 'exact', head: true })
  .in(
    'account_id',
    sandboxAccounts.length ? sandboxAccounts.map((a) => a.account_id) : ['__none__']
  )
if (txnErr) die('transactions', txnErr)

const { data: assets, error: assetErr } = await admin
  .from('manual_assets')
  .select('id, name, plaid_env')
if (assetErr) die('manual_assets', assetErr)

console.log('')
console.log(`Sandbox-owned accounts:     ${sandboxAccounts.length}`)
console.log(`Sandbox-owned transactions: ${sandboxTxnCount ?? 0}`)
console.log(`Accounts with no owning bank row: ${orphanAccounts.length}`)
console.log('Manual assets by environment:', assets.reduce((acc, a) => {
  acc[a.plaid_env] = (acc[a.plaid_env] ?? 0) + 1
  return acc
}, {}))

const dirty =
  sandboxAccounts.length > 0 || (sandboxTxnCount ?? 0) > 0 || orphanAccounts.length > 0
console.log('')
if (dirty) {
  console.log('CONTAMINATION FOUND. scripts/reset-plaid-data.mjs --confirm removes sandbox rows.')
  process.exit(2)
}
console.log('Clean: every account and transaction belongs to a bank in a single environment.')
```

- [ ] **Step 2: Verify it is genuinely read-only**

Run: `grep -nE "\.(delete|update|insert|upsert|rpc)\(" scripts/check-env-contamination.mjs`
Expected: no output. If anything matches, the script is not read-only — stop and fix it.

- [ ] **Step 3: Ask the user before running it against production**

Do **not** run this unprompted. Say: *"This connects to your live Supabase project and only reads. Ready?"* and wait for a yes.

Then run: `node --env-file=.env.local scripts/check-env-contamination.mjs`
Expected: exit 0 and `Clean: every account and transaction belongs to a bank in a single environment.`

If it exits 2, **stop and report to the user.** Cleanup with `scripts/reset-plaid-data.mjs` is their decision, not this plan's.

- [ ] **Step 4: Commit**

```bash
git add scripts/check-env-contamination.mjs
git commit -m "chore: read-only check for cross-environment rows (#23)"
```

---

### Task 2: The `app_env` migration

**Files:**
- Create: `db/migrations/017_app_env.sql`
- Modify: `db/migrations/011_manual_assets.sql:9` (correct a now-wrong comment)

**Interfaces:**
- Consumes: `plaid_items.plaid_env` (migration 010), `plaid_items.created_at` (migration 002).
- Produces: table `app_env` with columns `id boolean`, `plaid_env text`, `updated_at timestamptz`; exactly one row. Task 3 reads `plaid_env` from it.

- [ ] **Step 1: Write the migration**

```sql
-- The database's own identity.
--
-- One Supabase project serves local dev, Vercel Preview and production, so a laptop running
-- PLAID_ENV=sandbox can write sandbox banks into the database production reads from (#23). A
-- .env file can claim anything; this row is the DATABASE saying what it is, which is the one
-- claim a laptop cannot forge. lib/app-env.ts refuses to write household financial data when
-- the app's environment and this row disagree.
--
-- Chosen over denormalising plaid_env onto accounts + transactions and filtering every money
-- read: two functions create rows, ~14 places read them, and filtering fails toward real
-- transactions vanishing from the dashboard. See the design spec, 2026-09-01.
create table if not exists app_env (
  -- Single-row table: the check pins id to true, so a second row cannot be inserted.
  id boolean primary key default true check (id),
  plaid_env text not null check (plaid_env in ('sandbox','production')),
  updated_at timestamptz not null default now()
);

-- Seed from the most recently linked bank, so this configures itself correctly wherever it runs:
-- the production database says 'production', a fresh dev database with no banks says 'sandbox'.
-- Nothing is hardcoded, so re-running the migrations on a new project cannot mislabel it.
insert into app_env (id, plaid_env)
values (
  true,
  -- nulls last: plaid_items.created_at is nullable (002) and Postgres sorts NULLS FIRST on DESC,
  -- so a single null-timestamped row would outrank every real bank and decide what this whole
  -- database claims to be. id desc breaks exact-timestamp ties, so the seed is deterministic.
  coalesce(
    (select plaid_env from plaid_items order by created_at desc nulls last, id desc limit 1),
    'sandbox'
  )
)
on conflict (id) do nothing;

-- Server-only, like plaid_items (006): RLS on, no policy for authenticated, so the browser
-- cannot read it. All access is via the service_role client.
alter table app_env enable row level security;
```

- [ ] **Step 2: Correct the stale comment in migration 011**

`db/migrations/011_manual_assets.sql:9` currently reads:

```sql
  -- Which environment created it, for the future net-worth env-scoping (#23). Not filtered on yet.
```

Replace that single line with:

```sql
  -- Which environment created it. NOT filtered on when reading, and never will be: the write is
  -- guarded instead (#23, migration 017), so a wrong-environment row cannot be created at all.
  -- Kept as a record of which environment created each row.
```

Editing an already-applied migration is safe here because only a comment changes — nothing re-runs, and a fresh database set up per `README.md:73` reads the corrected text.

- [ ] **Step 3: Confirm the seed picks the right value BEFORE applying**

Ask the user to run this **read-only** query in the Supabase SQL Editor and report what it returns:

This must be the **same expression the migration uses**, or it verifies something the migration will not do:

```sql
select coalesce(
  (select plaid_env from plaid_items order by created_at desc nulls last, id desc limit 1),
  'sandbox'
) as will_seed_as;
```

Expected on the production database: `production`.

**If it returns `sandbox`, STOP.** Applying the migration would label the production database as sandbox, and Task 5's guard would then block every real sync. Report to the user instead of proceeding.

- [ ] **Step 4: Ask the user to apply the migration**

There is no runner. Ask them to paste `db/migrations/017_app_env.sql` into the Supabase SQL Editor and run it, then confirm with:

```sql
select * from app_env;
```

Expected: exactly one row, `id = true`, `plaid_env = production`.

- [ ] **Step 5: Commit**

```bash
git add db/migrations/017_app_env.sql db/migrations/011_manual_assets.sql
git commit -m "db: app_env records which Plaid environment owns this database (#23)"
```

---

### Task 3: `lib/app-env.ts` — the assertion

**Files:**
- Create: `lib/app-env.ts`
- Test: `tests/unit/app-env.test.ts`

**Interfaces:**
- Consumes: `supabaseAdmin` from `@/lib/supabase/admin`; `plaidEnv` from `@/lib/plaid`; the `app_env` table from Task 2.
- Produces, relied on by Tasks 4, 5 and 6:
  - `class EnvMismatchError extends Error` — thrown **only** when the two environments disagree. Has `readonly appEnv: 'sandbox' | 'production'` and `readonly databaseEnv: 'sandbox' | 'production'`.
  - `async function assertEnvMatchesDatabase(): Promise<void>` — resolves when they match; throws `EnvMismatchError` on mismatch; throws a plain `Error` when `app_env` cannot be read or is missing.

- [ ] **Step 1: Write the failing tests**

Note the `vi.resetModules()` + dynamic `import()` pattern: the module memoises the database's environment, so each test needs a fresh module instance. This is why the module needs no test-only reset export.

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

// lib/app-env.ts imports supabaseAdmin, whose module scope calls createClient(...). Vitest does
// not load .env.local, so without this the import throws "supabaseUrl is required" before any
// test body runs. Same reason as tests/unit/ingest-reimbursable.test.ts.
const maybeSingle = vi.fn()
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: { from: () => ({ select: () => ({ maybeSingle }) }) },
}))

// plaidEnv is a module constant frozen at import time, so the app side of the comparison has to
// be mocked to test a mismatch. vitest.config.ts pins the real one to 'sandbox'.
vi.mock('@/lib/plaid', () => ({ plaidEnv: 'sandbox' }))

async function freshModule() {
  vi.resetModules()
  return import('@/lib/app-env')
}

describe('assertEnvMatchesDatabase', () => {
  beforeEach(() => {
    maybeSingle.mockReset()
  })

  it('resolves when the database environment matches the app', async () => {
    maybeSingle.mockResolvedValue({ data: { plaid_env: 'sandbox' }, error: null })
    const { assertEnvMatchesDatabase } = await freshModule()
    await expect(assertEnvMatchesDatabase()).resolves.toBeUndefined()
  })

  it('throws EnvMismatchError when the database belongs to another environment', async () => {
    maybeSingle.mockResolvedValue({ data: { plaid_env: 'production' }, error: null })
    const { assertEnvMatchesDatabase, EnvMismatchError } = await freshModule()
    await expect(assertEnvMatchesDatabase()).rejects.toBeInstanceOf(EnvMismatchError)
  })

  it('names both environments in the mismatch error', async () => {
    maybeSingle.mockResolvedValue({ data: { plaid_env: 'production' }, error: null })
    const { assertEnvMatchesDatabase } = await freshModule()
    await expect(assertEnvMatchesDatabase()).rejects.toThrow(/sandbox.*production|production.*sandbox/)
  })

  // Fails CLOSED. A missing row must never be read as "no constraint configured, carry on" --
  // that would silently restore the exact hole this table exists to close.
  it('throws when the app_env row is missing', async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null })
    const { assertEnvMatchesDatabase } = await freshModule()
    await expect(assertEnvMatchesDatabase()).rejects.toThrow(/app_env/)
  })

  it('throws when app_env cannot be read', async () => {
    maybeSingle.mockResolvedValue({ data: null, error: { message: 'connection reset' } })
    const { assertEnvMatchesDatabase } = await freshModule()
    await expect(assertEnvMatchesDatabase()).rejects.toThrow(/connection reset/)
  })

  it('reads the database only once across repeated calls', async () => {
    maybeSingle.mockResolvedValue({ data: { plaid_env: 'sandbox' }, error: null })
    const { assertEnvMatchesDatabase } = await freshModule()
    await assertEnvMatchesDatabase()
    await assertEnvMatchesDatabase()
    await assertEnvMatchesDatabase()
    expect(maybeSingle).toHaveBeenCalledTimes(1)
  })

  // A cached failure would turn one transient blip into a permanent outage for that process,
  // because the guard fails closed. Cache the success, retry the failure.
  it('does not cache a failed read', async () => {
    maybeSingle.mockResolvedValueOnce({ data: null, error: { message: 'timeout' } })
    maybeSingle.mockResolvedValueOnce({ data: { plaid_env: 'sandbox' }, error: null })
    const { assertEnvMatchesDatabase } = await freshModule()
    await expect(assertEnvMatchesDatabase()).rejects.toThrow(/timeout/)
    await expect(assertEnvMatchesDatabase()).resolves.toBeUndefined()
    expect(maybeSingle).toHaveBeenCalledTimes(2)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/app-env.test.ts`
Expected: FAIL — cannot resolve `@/lib/app-env`.

- [ ] **Step 3: Write the implementation**

```ts
import 'server-only'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { plaidEnv } from '@/lib/plaid'

type Env = 'sandbox' | 'production'

// Thrown ONLY when the app and the database belong to different Plaid environments. Callers
// distinguish this from a plain Error to answer 409 (you are pointed at the wrong database)
// rather than 500 (something is broken).
export class EnvMismatchError extends Error {
  constructor(
    readonly appEnv: Env,
    readonly databaseEnv: Env
  ) {
    super(
      `This app is running in "${appEnv}" but the database belongs to "${databaseEnv}". ` +
        'Refusing to write bank data across environments.'
    )
    this.name = 'EnvMismatchError'
  }
}

// Memoised because the database cannot change identity under a running process. ONLY a
// successful read is cached: caching a failure would turn one transient blip into a permanent
// outage, since every guarded write fails closed.
let cachedDatabaseEnv: Env | null = null

async function databaseEnv(): Promise<Env> {
  if (cachedDatabaseEnv) return cachedDatabaseEnv

  const { data, error } = await supabaseAdmin.from('app_env').select('plaid_env').maybeSingle()

  if (error) throw new Error(`could not read app_env: ${error.message}`)
  // Fail closed. A missing row is not "unconfigured, carry on" -- it is the one condition this
  // table exists to rule out, so it must stop writes rather than wave them through.
  if (!data) throw new Error('app_env has no row: run db/migrations/017_app_env.sql')

  cachedDatabaseEnv = data.plaid_env as Env
  return cachedDatabaseEnv
}

// Call before writing any household financial data. Resolves if this app may write here.
export async function assertEnvMatchesDatabase(): Promise<void> {
  const dbEnv = await databaseEnv()
  if (dbEnv !== plaidEnv) throw new EnvMismatchError(plaidEnv, dbEnv)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/app-env.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/app-env.ts tests/unit/app-env.test.ts
git commit -m "feat: assert the app and database share a Plaid environment (#23)"
```

---

### Task 4: Guard the two ingest write functions

**Files:**
- Modify: `lib/ingest.ts` (add import; add one line at the top of `storeAccounts` and of `syncAndStore`)
- Test: `tests/unit/ingest-env-guard.test.ts`

**Interfaces:**
- Consumes: `assertEnvMatchesDatabase` from `@/lib/app-env` (Task 3).
- Produces: nothing new. `storeAccounts(householdId, plaidItemId, accessToken)` and `syncAndStore(item)` keep their existing signatures exactly.

- [ ] **Step 1: Write the failing tests**

These assert the guard runs **before** any Plaid call — a guarded function must not spend a network round trip, or write anything, when it is pointed at the wrong database.

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: {} }))

// vi.hoisted, NOT a plain `const x = vi.fn()`. The static `import ... from '@/lib/ingest'` below
// is evaluated before this file's own body runs, and linking it fires the '@/lib/plaid' mock
// factory — so a factory closing over a plain top-level const throws "Cannot access 'accountsGet'
// before initialization". vi.hoisted lifts the identities above the mocks.
// (tests/unit/app-env.test.ts avoids this only because it imports dynamically inside each test.)
const { accountsGet, syncItem, assertEnvMatchesDatabase } = vi.hoisted(() => ({
  accountsGet: vi.fn(),
  syncItem: vi.fn(),
  assertEnvMatchesDatabase: vi.fn(),
}))

vi.mock('@/lib/plaid', () => ({
  plaidEnv: 'sandbox',
  plaidClient: { accountsGet },
}))
vi.mock('@/lib/sync', () => ({ syncItem }))
vi.mock('@/lib/app-env', () => ({ assertEnvMatchesDatabase }))

import { storeAccounts, syncAndStore } from '@/lib/ingest'

describe('ingest environment guard', () => {
  beforeEach(() => {
    accountsGet.mockReset()
    syncItem.mockReset()
    assertEnvMatchesDatabase.mockReset()
  })

  it('storeAccounts refuses, and calls Plaid not at all, on a mismatch', async () => {
    assertEnvMatchesDatabase.mockRejectedValue(new Error('wrong environment'))
    await expect(storeAccounts('hh-1', 'item-1', 'access-token')).rejects.toThrow('wrong environment')
    expect(accountsGet).not.toHaveBeenCalled()
  })

  it('syncAndStore refuses, and syncs not at all, on a mismatch', async () => {
    assertEnvMatchesDatabase.mockRejectedValue(new Error('wrong environment'))
    await expect(
      syncAndStore({ id: 'item-1', household_id: 'hh-1', access_token: 'access-token' })
    ).rejects.toThrow('wrong environment')
    expect(syncItem).not.toHaveBeenCalled()
  })

  it('storeAccounts proceeds to Plaid when the environments match', async () => {
    assertEnvMatchesDatabase.mockResolvedValue(undefined)
    accountsGet.mockResolvedValue({ data: { accounts: [] } })
    await storeAccounts('hh-1', 'item-1', 'access-token')
    expect(accountsGet).toHaveBeenCalledOnce()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/ingest-env-guard.test.ts`
Expected: FAIL — the first two tests fail because `accountsGet` / `syncItem` **are** called; nothing stops them yet.

- [ ] **Step 3: Add the guard**

In `lib/ingest.ts`, add to the existing imports at the top of the file:

```ts
import { assertEnvMatchesDatabase } from '@/lib/app-env'
```

Then make the first statement of `storeAccounts` (currently `const acc = await plaidClient.accountsGet(...)`):

```ts
export async function storeAccounts(householdId: string, plaidItemId: string, accessToken: string) {
  // Before the network call, not after: a wrong-environment write must cost nothing (#23).
  await assertEnvMatchesDatabase()
  const acc = await plaidClient.accountsGet({ access_token: accessToken })
```

And the first statement of `syncAndStore` (currently `const { added, modified, removed, next_cursor } = await syncItem(...)`):

```ts
export async function syncAndStore(item: {
  id: string
  household_id: string
  access_token: string
  cursor?: string | null
}) {
  // Backstop. The sync, webhook and reconnect callers already filter items by plaid_env, so this
  // should be unreachable from them -- it is here so a FUTURE caller cannot reopen #23.
  await assertEnvMatchesDatabase()
  const { added, modified, removed, next_cursor } = await syncItem(
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/ingest-env-guard.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Run the whole suite — the existing ingest tests share this module**

Run: `npm test -- --run`
Expected: all pass. `tests/unit/ingest-reimbursable.test.ts` only exercises `transactionUpsertRow`, a pure function that never calls the guard, so it needs no change. **If it now fails, do not weaken the guard** — add `vi.mock('@/lib/app-env', ...)` to that file instead.

- [ ] **Step 6: Commit**

```bash
git add lib/ingest.ts tests/unit/ingest-env-guard.test.ts
git commit -m "feat: ingest refuses to write across Plaid environments (#23)"
```

---

### Task 5: Guard the bank-link route

The one genuinely dangerous door. The guard must run **before** the `plaid_items` insert, or a refused link leaves an orphaned bank row and spends an unrefundable Plaid slot.

**Files:**
- Modify: `app/api/plaid/exchange-public-token/route.ts`
- Test: `tests/unit/exchange-public-token-env.test.ts`

**Interfaces:**
- Consumes: `assertEnvMatchesDatabase`, `EnvMismatchError` from `@/lib/app-env` (Task 3).
- Produces: nothing later tasks import.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

// vi.hoisted for the same reason as tests/unit/ingest-env-guard.test.ts: the static route import
// below is linked before this file's body runs, firing every mock factory, so a factory closing
// over a plain top-level const throws "Cannot access 'x' before initialization".
const { insert, itemPublicTokenExchange, getUser, assertEnvMatchesDatabase } = vi.hoisted(() => ({
  insert: vi.fn(),
  itemPublicTokenExchange: vi.fn(),
  getUser: vi.fn(),
  assertEnvMatchesDatabase: vi.fn(),
}))

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: { from: () => ({ insert }) },
}))
vi.mock('@/lib/plaid', () => ({
  plaidEnv: 'sandbox',
  plaidClient: { itemPublicTokenExchange },
}))
// The guard sits AFTER the auth and household checks, so those have to succeed for the test to
// reach it. Same client shape as tests/unit/manual-assets-env.test.ts.
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser },
    from: () => ({
      select: () => ({
        limit: () => ({ single: async () => ({ data: { household_id: 'hh-1' } }) }),
      }),
    }),
  }),
}))
vi.mock('@/lib/crypto', () => ({ encrypt: (s: string) => s }))
vi.mock('@/lib/ingest', () => ({ storeAccounts: vi.fn(), syncAndStore: vi.fn() }))

// Keep the real EnvMismatchError so the route's `instanceof` branch is exercised for real; replace
// only the assertion the test drives.
vi.mock('@/lib/app-env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/app-env')>()),
  assertEnvMatchesDatabase,
}))

import { EnvMismatchError } from '@/lib/app-env'

import { POST } from '@/app/api/plaid/exchange-public-token/route'

function linkRequest() {
  return new Request('http://localhost/api/plaid/exchange-public-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ public_token: 'public-sandbox-1', institution_name: 'Test Bank' }),
  })
}

describe('POST /api/plaid/exchange-public-token environment guard', () => {
  beforeEach(() => {
    insert.mockReset()
    itemPublicTokenExchange.mockReset()
    assertEnvMatchesDatabase.mockReset()
    getUser.mockResolvedValue({ data: { user: { id: 'user-1' } } })
  })

  it('answers 409 when pointed at another environment’s database', async () => {
    assertEnvMatchesDatabase.mockRejectedValue(new EnvMismatchError('sandbox', 'production'))
    const res = await POST(linkRequest())
    expect(res.status).toBe(409)
  })

  it('creates no plaid_items row and exchanges no token on a mismatch', async () => {
    assertEnvMatchesDatabase.mockRejectedValue(new EnvMismatchError('sandbox', 'production'))
    await POST(linkRequest())
    expect(insert).not.toHaveBeenCalled()
    expect(itemPublicTokenExchange).not.toHaveBeenCalled()
  })

  it('answers 500, not 409, when app_env simply cannot be read', async () => {
    assertEnvMatchesDatabase.mockRejectedValue(new Error('could not read app_env: timeout'))
    const res = await POST(linkRequest())
    expect(res.status).toBe(500)
    expect(insert).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/exchange-public-token-env.test.ts`
Expected: FAIL — no guard exists, so the route proceeds past it.

- [ ] **Step 3: Add the guard to the route**

Add to the imports:

```ts
import { assertEnvMatchesDatabase, EnvMismatchError } from '@/lib/app-env'
```

Then insert this immediately after `const productList = normalizeProducts(products)` — i.e. after the auth check (`if (!user)`) and the household check (`if (!membership)`), and directly above the `// THE ITEM ALREADY EXISTS AT PLAID` comment block. That position is **after** authentication, so an unauthenticated request is rejected without touching the database, and still **before** the token exchange and the `plaid_items` insert, which is what the guard has to beat:

```ts
  // Before the token exchange AND before the plaid_items insert. Linking is the only path that
  // can put a wrong-environment bank into this database (#23), and a guard that fired later
  // would leave an orphaned row behind and spend one of ten unrefundable Plaid slots.
  try {
    await assertEnvMatchesDatabase()
  } catch (e) {
    if (e instanceof EnvMismatchError) {
      console.error('[plaid] refusing to link across environments', e.message)
      return NextResponse.json(
        {
          error:
            'This app is pointed at a database from a different Plaid environment, so linking a ' +
            'bank was refused. Nothing was connected.',
        },
        { status: 409 }
      )
    }
    console.error('[plaid] environment guard could not run', e)
    return NextResponse.json(
      { error: 'Could not verify which database this is, so nothing was connected.' },
      { status: 500 }
    )
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/exchange-public-token-env.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add app/api/plaid/exchange-public-token/route.ts tests/unit/exchange-public-token-env.test.ts
git commit -m "feat: refuse to link a bank across Plaid environments (#23)"
```

---

### Task 6: Guard the manual-assets write

Closes the loose end migration 011 left as `-- Not filtered on yet.` — by guarding the write, so the read never needs a filter.

**Files:**
- Modify: `app/api/manual-assets/route.ts`
- Test: `tests/unit/manual-assets-env.test.ts`

**Interfaces:**
- Consumes: `assertEnvMatchesDatabase`, `EnvMismatchError` from `@/lib/app-env` (Task 3).
- Produces: nothing later tasks import.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

// vi.hoisted for the same reason as tests/unit/ingest-env-guard.test.ts: the static route import
// below is linked before this file's body runs, firing every mock factory.
const { upsert, getUser, assertEnvMatchesDatabase } = vi.hoisted(() => ({
  upsert: vi.fn(),
  getUser: vi.fn(),
  assertEnvMatchesDatabase: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser },
    from: (table: string) =>
      table === 'memberships'
        ? {
            select: () => ({
              limit: () => ({ single: async () => ({ data: { household_id: 'hh-1' } }) }),
            }),
          }
        : { upsert },
  }),
}))

vi.mock('@/lib/plaid', () => ({ plaidEnv: 'sandbox' }))
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: {} }))

// Keep the real EnvMismatchError so the route's `instanceof` branch is exercised for real; replace
// only the assertion the test drives.
vi.mock('@/lib/app-env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/app-env')>()),
  assertEnvMatchesDatabase,
}))

import { EnvMismatchError } from '@/lib/app-env'
import { POST } from '@/app/api/manual-assets/route'

function saveRequest() {
  return new Request('http://localhost/api/manual-assets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: 750000 }),
  })
}

describe('POST /api/manual-assets environment guard', () => {
  beforeEach(() => {
    upsert.mockReset()
    assertEnvMatchesDatabase.mockReset()
    getUser.mockResolvedValue({ data: { user: { id: 'user-1' } } })
    upsert.mockResolvedValue({ error: null })
  })

  it('answers 409 and writes nothing on a mismatch', async () => {
    assertEnvMatchesDatabase.mockRejectedValue(new EnvMismatchError('sandbox', 'production'))
    const res = await POST(saveRequest())
    expect(res.status).toBe(409)
    expect(upsert).not.toHaveBeenCalled()
  })

  it('writes normally when the environments match', async () => {
    assertEnvMatchesDatabase.mockResolvedValue(undefined)
    const res = await POST(saveRequest())
    expect(res.status).toBe(200)
    expect(upsert).toHaveBeenCalledOnce()
  })

  // The 409/500 split is the whole reason lib/app-env.ts throws two error types. Without this
  // case the 500 branch ships untested, and a refactor collapsing both into one status would
  // still go green. Mirrors the equivalent case in tests/unit/exchange-public-token-env.test.ts.
  it('answers 500, not 409, when app_env simply cannot be read', async () => {
    assertEnvMatchesDatabase.mockRejectedValue(new Error('could not read app_env: timeout'))
    const res = await POST(saveRequest())
    expect(res.status).toBe(500)
    expect(upsert).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/manual-assets-env.test.ts`
Expected: FAIL — the first test gets 200 and `upsert` is called.

- [ ] **Step 3: Add the guard to the route**

Add to the imports:

```ts
import { assertEnvMatchesDatabase, EnvMismatchError } from '@/lib/app-env'
```

Then insert immediately after the `if (!m) return ...` household check, before the `upsert`:

```ts
  // Guarding the write is why lib/manual-assets.ts never needs a plaid_env read filter: a
  // wrong-environment row cannot be created in the first place (#23).
  try {
    await assertEnvMatchesDatabase()
  } catch (e) {
    if (e instanceof EnvMismatchError) {
      return NextResponse.json(
        { error: 'This app is pointed at a database from a different environment. Nothing saved.' },
        { status: 409 }
      )
    }
    console.error('[manual-assets] environment guard could not run', e)
    return NextResponse.json(
      { error: 'Could not verify which database this is, so nothing was saved.' },
      { status: 500 }
    )
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/manual-assets-env.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add app/api/manual-assets/route.ts tests/unit/manual-assets-env.test.ts
git commit -m "feat: refuse manual-asset writes across environments (#23)"
```

---

### Task 7: Full verification and pull request

**Files:**
- Modify: `docs/plaid-production-cutover.md` (the operational rule is now enforced in code)

**Interfaces:**
- Consumes: everything above.
- Produces: a pull request closing #23.

- [ ] **Step 1: Run every check**

```bash
npm test -- --run
npx tsc --noEmit
npm run lint
npm run check:secrets
```

Expected: all four green. Baseline was 168 tests in 20 files; this plan adds 16 tests in 4 files, so expect **184 tests in 24 files**. A different total means a test was silently dropped — investigate before continuing.

- [ ] **Step 2: Prove the guard works against the real database**

Ask the user to run the dev server with its normal sandbox settings, pointed at the production Supabase project (`npm run dev`), and attempt to link a bank from Settings.

Expected: the link is refused with the 409 message, and no new row appears in `plaid_items`.

Then ask them to confirm the production deployment is unaffected: on `every-dollar-counts.vercel.app`, press **Refresh** on the dashboard and confirm transactions still sync. **This is the check that matters most** — it proves the seed value from Task 2 was right and that real syncing still works.

- [ ] **Step 3: Update the cutover runbook**

In `docs/plaid-production-cutover.md`, find the standing rule *"never link a bank from a local or Preview session against the live database"* and append:

```markdown
As of #23 this rule is enforced in code, not just by discipline: `db/migrations/017_app_env.sql`
records which environment owns the database, and every write path asserts a match before writing.
A local session pointed at the production database now gets a 409 when linking a bank rather than
silently writing sandbox accounts into real net worth.
```

- [ ] **Step 4: Commit and open the pull request**

```bash
git add docs/plaid-production-cutover.md
git commit -m "docs: the no-cross-environment-linking rule is now enforced in code (#23)"
git push
gh pr create --fill --title "Environment write guard: close #23 at the write door"
```

The PR body must state: what changed, that **no read site and no existing table was touched**, that migration 017 must be applied by hand before deploying, and `Closes #23`.

---

## Self-Review

**Spec coverage.** §1 → Tasks 4–6. §2 (decision) → no task; it is rationale. §3 (mechanism) → Task 2. §4 (four call sites, caching, fail-closed) → Tasks 3–6; the caching and fail-closed rules are Task 3 Steps 1 and 3. §5 (contamination check, manual-assets loose end) → Tasks 1 and 6 plus the 011 comment in Task 2. §6 (testing table) → every row appears: match/mismatch/missing row → Task 3; retry-after-failure → Task 3; link 409 with no item created → Task 5; manual-asset 409 → Task 6. §7 (not doing) → enforced by omission; Task 7 Step 4 makes it explicit in the PR. §8 (consequences) → Task 7 Steps 2–3. §9 (rejected alternatives) → rationale, no task. **No gaps.**

**Placeholder scan.** No TBD/TODO, no "add appropriate error handling", no "similar to Task N", no "write tests for the above". Every code step carries real code.

**Type consistency.** `assertEnvMatchesDatabase(): Promise<void>` and `EnvMismatchError(appEnv, databaseEnv)` are defined in Task 3 and used with those exact names and arities in Tasks 4, 5 and 6. `Env` is `'sandbox' | 'production'` everywhere, matching `lib/plaid.ts:18`. `storeAccounts` and `syncAndStore` keep their existing signatures, so no caller changes.
