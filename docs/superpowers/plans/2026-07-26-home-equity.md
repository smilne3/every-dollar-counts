# Home Equity in Net Worth — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`).

**Goal:** Count the home's value toward net worth — a manually-entered home value on the asset side, netting against the live Wells Fargo mortgage that already loads as a liability.

**Architecture:** A new `manual_assets` table holds things you own that aren't bank accounts (the home, for now). Net worth adds the sum of manual assets to the existing `assets − liabilities`. A Settings card edits the home value; a dashboard nudge appears when it's gone stale (>30 days). No change to the mortgage — it stays a live Plaid liability, so the house's net contribution is automatically `home value − mortgage`.

**Tech Stack:** Next.js 16 · TypeScript · Supabase (Postgres + RLS) · Vitest.

**Issue:** #30 · **Design:** captured in the #30 issue body (approved).

## Global Constraints

- **This is Next.js 16.** Pages/routes differ; `searchParams`/`params` are Promises.
- **RLS pattern:** `for all to authenticated using (household_id in (select private.household_ids())) with check (...)` — copy from `009_goals.sql`.
- **API routes** use the RLS-scoped client (`createClient`), not the admin client — RLS enforces the household. Follow `app/api/goals/route.ts`.
- **Money** rendered with `money()`; never hand-format.
- **Net worth must stay reconciled:** the dashboard tile, the `/breakdown/net-worth` page, and any test must all include manual assets the same way.
- **Env note:** `manual_assets` carries `plaid_env` (stamped at write) for the future #23 scoping sweep, but this feature does not filter reads on it — matching the current un-scoped dashboard.
- **Commands:** `npx vitest run` · `npx tsc --noEmit` · `npm run lint` · `npm run build`.
- **Commit after every task.** Branch `feature/home-equity`.

---

## File map

**Create:**
- `db/migrations/011_manual_assets.sql` — the table + RLS + unique(household_id, name).
- `lib/manual-assets.ts` — `sumManualAssets` (pure, tested) + a server helper to read the household's manual assets.
- `app/api/manual-assets/route.ts` — upsert the home value.
- `components/HomeValueCard.tsx` — the Settings editor (client).
- `tests/unit/manual-assets.test.ts`

**Modify:**
- `app/(app)/dashboard/page.tsx` — add manual assets to net worth; add the stale-value nudge.
- `app/(app)/breakdown/[metric]/page.tsx` — include manual assets as asset rows in the Net Worth breakdown and its total.
- `app/(app)/settings/page.tsx` — render `HomeValueCard`.

---

## Task 1: Migration + pure helper

**Files:**
- Create: `db/migrations/011_manual_assets.sql`, `lib/manual-assets.ts`, `tests/unit/manual-assets.test.ts`

**Interfaces:**
- Produces: `sumManualAssets(assets: { value: number | null }[]): number`; `type ManualAsset = { id: string; name: string; value: number; updated_at: string }`.

- [ ] **Step 1: Write the migration**

Create `db/migrations/011_manual_assets.sql`:

```sql
-- Phase 6: manually-entered assets that aren't bank accounts (the home, for now).
-- Counted on the asset side of net worth; the mortgage stays a live Plaid liability, so the home's
-- net contribution is automatically (home value - mortgage balance).
create table if not exists manual_assets (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  name text not null,
  value numeric not null default 0,
  -- Which environment created it, for the future net-worth env-scoping (#23). Not filtered on yet.
  plaid_env text not null default 'sandbox',
  updated_at timestamptz not null default now(),
  created_at timestamptz default now(),
  unique (household_id, name)
);

alter table manual_assets enable row level security;
drop policy if exists "manage your manual assets" on manual_assets;
create policy "manage your manual assets" on manual_assets
  for all to authenticated
  using ( household_id in (select private.household_ids()) )
  with check ( household_id in (select private.household_ids()) );
```

- [ ] **Step 2: Write the failing test**

Create `tests/unit/manual-assets.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { sumManualAssets } from '@/lib/manual-assets'

describe('sumManualAssets', () => {
  it('sums values, treating null as zero', () => {
    expect(sumManualAssets([{ value: 500000 }, { value: null }, { value: 12000 }])).toBe(512000)
  })
  it('is zero for an empty list', () => {
    expect(sumManualAssets([])).toBe(0)
  })
})
```

- [ ] **Step 3: Run it — expect FAIL** (`npx vitest run tests/unit/manual-assets.test.ts`).

- [ ] **Step 4: Implement `lib/manual-assets.ts`**

```ts
import 'server-only'
import { supabaseAdmin } from '@/lib/supabase/admin'

export type ManualAsset = { id: string; name: string; value: number; updated_at: string }

// Total of a household's manual assets (currently just the home). Added to the asset side of
// net worth alongside Plaid account balances.
export function sumManualAssets(assets: { value: number | null }[]): number {
  return assets.reduce((s, a) => s + (a.value ?? 0), 0)
}

// Read a household's manual assets. RLS has a policy, but net worth is computed in server components
// that already use the service-role client for cross-cutting reads; keep it consistent here.
export async function listManualAssets(householdId: string): Promise<ManualAsset[]> {
  const { data } = await supabaseAdmin
    .from('manual_assets')
    .select('id, name, value, updated_at')
    .eq('household_id', householdId)
    .order('name')
  return (data ?? []) as ManualAsset[]
}
```

- [ ] **Step 5: Run it — expect PASS.**

- [ ] **Step 6: Apply the migration to Supabase and verify**

Apply `011_manual_assets.sql` in the SQL editor. Verify:

```sql
select column_name from information_schema.columns where table_name = 'manual_assets';
select policyname from pg_policies where tablename = 'manual_assets';
```

Expected: the columns and one policy.

- [ ] **Step 7: Commit**

```bash
git add db/migrations/011_manual_assets.sql lib/manual-assets.ts tests/unit/manual-assets.test.ts
git commit -m "feat(db): manual_assets table + sumManualAssets helper"
```

---

## Task 2: API route to save the home value

**Files:**
- Create: `app/api/manual-assets/route.ts`

**Interfaces:**
- Produces: `POST /api/manual-assets` body `{ value: number }` — upserts the household's `Home` asset, stamping `updated_at` and `plaid_env`.

- [ ] **Step 1: Create the route**

```ts
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { plaidEnv } from '@/lib/plaid'

// Upsert the household's home value. One manual asset named 'Home' per household (unique constraint
// household_id, name), so re-saving updates it and refreshes updated_at (which drives the stale
// nudge on the dashboard).
export async function POST(req: Request) {
  const { value } = await req.json()
  const v = Number(value)
  if (!(v >= 0)) {
    return NextResponse.json({ error: 'a non-negative value is required' }, { status: 400 })
  }
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const { data: m } = await supabase.from('memberships').select('household_id').limit(1).single()
  if (!m) return NextResponse.json({ error: 'no household' }, { status: 403 })

  const { error } = await supabase.from('manual_assets').upsert(
    {
      household_id: m.household_id,
      name: 'Home',
      value: v,
      plaid_env: plaidEnv,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'household_id,name' }
  )
  if (error) return NextResponse.json({ error: error.message }, { status: 400 })
  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 2: Typecheck, lint, build** (`npx tsc --noEmit && npm run lint && npm run build`).

- [ ] **Step 3: Commit**

```bash
git add app/api/manual-assets/route.ts
git commit -m "feat(api): upsert the household home value"
```

---

## Task 3: Home value card in Settings

**Files:**
- Create: `components/HomeValueCard.tsx`
- Modify: `app/(app)/settings/page.tsx`

**Interfaces:**
- Consumes: `POST /api/manual-assets`.
- Produces: `HomeValueCard({ initialValue, updatedAt }: { initialValue: number | null; updatedAt: string | null })`.

- [ ] **Step 1: Create `components/HomeValueCard.tsx`**

```tsx
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/Button'
import { inputClass } from '@/components/ui/styles'
import { money } from '@/lib/format'

// Edits the household's home value. Enter what Zillow shows; the app subtracts the live mortgage
// automatically (it's already a liability), so net worth reflects home equity.
export function HomeValueCard({
  initialValue,
  updatedAt,
}: {
  initialValue: number | null
  updatedAt: string | null
}) {
  const router = useRouter()
  const [value, setValue] = useState(initialValue != null ? String(initialValue) : '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save(e: React.FormEvent) {
    e.preventDefault()
    const v = Number(value)
    if (!(v >= 0)) {
      setError('Enter a number (what your home is worth).')
      return
    }
    setBusy(true)
    setError(null)
    const res = await fetch('/api/manual-assets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: v }),
    }).catch(() => null)
    setBusy(false)
    if (!res || !res.ok) {
      setError("Couldn't save that. Please try again.")
      return
    }
    router.refresh()
  }

  return (
    <form onSubmit={save} className="space-y-2">
      {initialValue != null && (
        <p className="text-sm text-muted">
          Currently {money(initialValue)}
          {updatedAt && ` · updated ${new Date(updatedAt).toLocaleDateString()}`}
        </p>
      )}
      <div className="flex max-w-sm items-center gap-2">
        <input
          inputMode="numeric"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="e.g. 750000"
          className={inputClass}
          aria-label="Home value"
        />
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
      </div>
      <p className="text-xs text-faint">
        Check Zillow for your estimate and enter it here. Your mortgage is subtracted automatically.
      </p>
      {error && <p className="text-sm text-coral">{error}</p>}
    </form>
  )
}
```

- [ ] **Step 2: Wire it into Settings**

In `app/(app)/settings/page.tsx`, add imports:

```tsx
import { HomeValueCard } from '@/components/HomeValueCard'
import { listManualAssets } from '@/lib/manual-assets'
```

After `const household = households?.[0]`, add:

```tsx
  const manualAssets = household ? await listManualAssets(household.id) : []
  const home = manualAssets.find((a) => a.name === 'Home') ?? null
```

Add a new `Card` in the returned JSX (after the Banks card, before Categories):

```tsx
      <Card className="p-5 space-y-3">
        <h2 className="text-base font-semibold text-ink">Home value</h2>
        <p className="text-sm text-muted">
          Add your home&apos;s value so net worth reflects your equity. The mortgage is already
          counted as a debt, so the app shows what the house adds after the loan.
        </p>
        <HomeValueCard initialValue={home?.value ?? null} updatedAt={home?.updated_at ?? null} />
      </Card>
```

- [ ] **Step 3: Typecheck, lint, build** (`npx tsc --noEmit && npm run lint && npm run build`).

- [ ] **Step 4: Commit**

```bash
git add components/HomeValueCard.tsx "app/(app)/settings/page.tsx"
git commit -m "feat(settings): edit the home value"
```

---

## Task 4: Net worth includes home equity + dashboard stale nudge

**Files:**
- Modify: `app/(app)/dashboard/page.tsx`, `app/(app)/breakdown/[metric]/page.tsx`

**Interfaces:**
- Consumes: `sumManualAssets`, `listManualAssets` (`@/lib/manual-assets`).

- [ ] **Step 1: Dashboard — add manual assets to net worth and a stale nudge**

In `app/(app)/dashboard/page.tsx`:

Add imports:

```tsx
import { sumManualAssets, listManualAssets } from '@/lib/manual-assets'
```

Where `items` is fetched (there is already a `membershipRow` with `household_id`), add after it:

```tsx
  const manualAssets = membershipRow ? await listManualAssets(membershipRow.household_id) : []
  const home = manualAssets.find((a) => a.name === 'Home') ?? null
  const homeStale =
    home != null && Date.now() - new Date(home.updated_at).getTime() > 30 * 24 * 60 * 60 * 1000
```

Change the net worth computation from `const worth = netWorth(accounts)` to:

```tsx
  const worth = netWorth(accounts) + sumManualAssets(manualAssets)
```

Add the nudge alongside the broken-bank banner (just after it, inside the same top-of-page area):

```tsx
      {homeStale && (
        <Link
          href="/settings"
          className="block rounded-card border border-amber/40 bg-amber/10 px-4 py-3 text-sm text-amber-700"
        >
          Your home value was last updated over a month ago — check Zillow and update it in Settings.
        </Link>
      )}
```

(If `amber-700`/`border-amber` tokens don't exist, use the muted style: `border-line bg-surface-2 text-muted`. Confirm against `app/globals.css`.)

- [ ] **Step 2: Breakdown — show the home in the Net Worth breakdown**

In `app/(app)/breakdown/[metric]/page.tsx`, in the `net-worth` branch, after building the account rows, fetch and append manual assets as asset rows and include them in the total.

Add import:

```tsx
import { sumManualAssets, listManualAssets } from '@/lib/manual-assets'
```

The `net-worth` branch needs the household id — add a membership lookup at the top of the page (after `accounts`):

```tsx
  const { data: membershipRow } = await supabase
    .from('memberships')
    .select('household_id')
    .limit(1)
    .single()
  const manualAssets = membershipRow
    ? await (await import('@/lib/manual-assets')).listManualAssets(membershipRow.household_id)
    : []
```

Then in the `net-worth` branch, after the account rows are built, insert manual-asset rows before the liabilities and add to the total:

```tsx
    const manualRows = manualAssets.map((a) => ({
      key: `manual-${a.id}`,
      label: a.name,
      sub: 'Manually entered',
      amount: a.value,
      currency,
      owed: false,
      // no href — manual assets have no transactions
    }))
    rows = [...g.assets, ...manualRows, ...g.liabilities].map(/* existing mapping OR keep manualRows already shaped */)
    total = { label: 'Net worth', amount: netWorth(accounts) + sumManualAssets(manualAssets), currency }
```

> Implementation note: the existing `net-worth` branch maps `g.assets`/`g.liabilities` into rows. Insert `manualRows` (already in `BreakdownRow` shape) between the mapped assets and mapped liabilities, and add `sumManualAssets(manualAssets)` to the total. Keep the account rows' drill links; manual rows have none.

- [ ] **Step 3: Typecheck, lint, build** (`npx tsc --noEmit && npm run lint && npm run build`).

- [ ] **Step 4: Commit**

```bash
git add "app/(app)/dashboard/page.tsx" "app/(app)/breakdown/[metric]/page.tsx"
git commit -m "feat(dashboard): count home equity in net worth, with a stale-value nudge"
```

---

## Task 5: Manual verification

- [ ] **Step 1:** `npm run dev`, sign in. In Settings, enter a home value; confirm it saves and shows "Currently $X · updated <today>".
- [ ] **Step 2:** On the dashboard, confirm net worth increased by the home value; drill Net Worth → the home appears as an asset row (no drill link), the mortgage as a liability, and the total reconciles.
- [ ] **Step 3:** Confirm no stale nudge shows for a just-updated value. (The >30-day path can be checked by temporarily backdating `updated_at` in the DB, then reverting.)

---

## Final verification

- [ ] `npx vitest run` — all pass, incl. `manual-assets.test.ts`.
- [ ] `npx tsc --noEmit && npm run lint && npm run build && npm run check:secrets` — clean.
- [ ] Manual check (Task 5) done.
- [ ] Open a PR from `feature/home-equity` (closes #30).
