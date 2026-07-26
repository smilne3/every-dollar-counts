# Dashboard Drill-Down Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the four dashboard tiles (Net Worth, Cash on Hand, Spent, Saved) clickable so a user can drill from a tile to the accounts/categories that total it, then to the individual transactions.

**Architecture:** A new dynamic route `/breakdown/[metric]` renders the roll-up (level 1) using the existing roll-up math; rows link to the existing `/transactions` page, now made filter-aware (level 2). No new roll-up math — pure display/navigation over `lib/dashboard.ts` and `lib/budget.ts`.

**Tech Stack:** Next.js 16 (App Router, async Server Components) · TypeScript · Tailwind v4 · Supabase (Postgres + RLS) · Vitest.

**Spec:** `docs/superpowers/specs/2026-07-25-dashboard-drill-down-design.md`

## Global Constraints

- **This is Next.js 16, not the version you know.** Route handlers/pages differ from older Next; pages are `async` Server Components and `params`/`searchParams` are **Promises** that must be `await`ed. Confirm against `node_modules/next/dist/docs/` before writing a page.
- **Path alias is `@/`.** Client components start with `'use client'`; server-only modules must not be imported into client components.
- **Money is rendered with `money(amount, currency)` from `@/lib/format`.** Never hand-format currency.
- **Reuse the roll-up math — do not re-derive it.** `netWorth`, `cashOnHand`, `isLiability` (`@/lib/dashboard`); `spendByCategory` (`@/lib/budget`); `effectiveCategory` (`@/lib/effective-category`); `pfcToName`/`nonSpendingNames` (`@/lib/categories`). The breakdown totals must equal the tile totals.
- **Environment scoping is out of scope here.** The breakdown reads match the dashboard's existing (un-env-scoped) queries; consistent `plaid_env` scoping across all money reads is #23's job. (This revises the spec's note about scoping the new reads — a half-measure here would be inconsistent with the dashboard; #23 does it everywhere at once.)
- **Commands:** test `npx vitest run` · typecheck `npx tsc --noEmit` · lint `npm run lint` · build `npm run build`.
- **Commit after every task.** Branch: `feature/dashboard-drill-down`.

---

## File map

**Create:**
- `lib/breakdown.ts` — pure helpers: group accounts into assets/liabilities with totals; sort category spend into rows. Unit-tested.
- `components/BreakdownList.tsx` — presentational list of breakdown rows (label, sub-label, amount, optional drill link) with an optional total row.
- `app/(app)/breakdown/[metric]/page.tsx` — the dynamic breakdown route; one thin server component switching on `metric`.
- `tests/unit/breakdown.test.ts`

**Modify:**
- `components/ui/StatCard.tsx` — optional `href` makes the tile a link.
- `app/(app)/dashboard/page.tsx` — pass `href` to the four tiles.
- `app/(app)/transactions/page.tsx` — accept `account` / `category` / `month` / `flow` filters + a filter chip.

---

## Task 1: Pure breakdown helpers

**Files:**
- Create: `lib/breakdown.ts`, `tests/unit/breakdown.test.ts`

**Interfaces:**
- Consumes: `ASSET`/`LIABILITY` classification via `isLiability` (`@/lib/dashboard`).
- Produces:
  - `type BreakdownAccount = { id: string; account_id: string; name: string; subtype: string | null; balance: number; owed: boolean }`
  - `groupAccountsByKind(accounts): { assets: BreakdownAccount[]; liabilities: BreakdownAccount[]; assetTotal: number; liabilityTotal: number; net: number }`
  - `sortedSpendRows(byCat: Record<string, number>): { category: string; amount: number }[]` (descending by amount)

- [ ] **Step 1: Write the failing test**

Create `tests/unit/breakdown.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { groupAccountsByKind, sortedSpendRows } from '@/lib/breakdown'

const acct = (
  account_id: string,
  type: string | null,
  current_balance: number | null,
  name = 'Acct',
  subtype: string | null = null
) => ({ id: `uuid-${account_id}`, account_id, type, current_balance, name, subtype })

describe('groupAccountsByKind', () => {
  it('splits assets from liabilities and totals each, with net = assets - liabilities', () => {
    const r = groupAccountsByKind([
      acct('a', 'depository', 8000),
      acct('b', 'investment', 2000),
      acct('c', 'other', 100),
      acct('d', 'credit', 500),
      acct('e', 'loan', 10000),
    ])
    expect(r.assetTotal).toBe(10100)
    expect(r.liabilityTotal).toBe(10500)
    expect(r.net).toBe(-400)
    expect(r.assets.map((a) => a.account_id)).toEqual(['a', 'b', 'c'])
    expect(r.liabilities.map((a) => a.account_id)).toEqual(['d', 'e'])
    expect(r.liabilities[0].owed).toBe(true)
    expect(r.assets[0].owed).toBe(false)
  })

  it('treats null balances as zero and ignores unknown types', () => {
    const r = groupAccountsByKind([acct('a', 'depository', null), acct('x', 'weird', 999)])
    expect(r.assetTotal).toBe(0)
    expect(r.liabilityTotal).toBe(0)
    expect(r.assets.map((a) => a.account_id)).toEqual(['a']) // depository with null balance still listed
  })
})

describe('sortedSpendRows', () => {
  it('returns rows sorted by amount descending', () => {
    const r = sortedSpendRows({ Food: 12, Travel: 300, Shopping: 89 })
    expect(r).toEqual([
      { category: 'Travel', amount: 300 },
      { category: 'Shopping', amount: 89 },
      { category: 'Food', amount: 12 },
    ])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/unit/breakdown.test.ts`
Expected: FAIL — cannot resolve `@/lib/breakdown`.

- [ ] **Step 3: Implement `lib/breakdown.ts`**

```ts
import { isLiability } from '@/lib/dashboard'

// A row for the Net Worth / Cash breakdown. Carries account_id (Plaid's text id) because that is
// what the transactions drill-down filters on — NOT the internal `id` uuid.
export type BreakdownAccount = {
  id: string
  account_id: string
  name: string
  subtype: string | null
  balance: number
  owed: boolean
}

type RawAccount = {
  id: string
  account_id: string
  name: string | null
  type: string | null
  subtype: string | null
  current_balance: number | null
}

const ASSET_TYPES = new Set(['depository', 'investment', 'other'])

// Split accounts into assets and liabilities with per-side totals and the net. Mirrors netWorth()
// in lib/dashboard.ts so the breakdown page and the Net Worth tile can never disagree.
export function groupAccountsByKind(accounts: RawAccount[]): {
  assets: BreakdownAccount[]
  liabilities: BreakdownAccount[]
  assetTotal: number
  liabilityTotal: number
  net: number
} {
  const assets: BreakdownAccount[] = []
  const liabilities: BreakdownAccount[] = []
  let assetTotal = 0
  let liabilityTotal = 0
  for (const a of accounts) {
    const balance = a.current_balance ?? 0
    const row: BreakdownAccount = {
      id: a.id,
      account_id: a.account_id,
      name: a.name ?? 'Account',
      subtype: a.subtype,
      balance,
      owed: isLiability(a.type),
    }
    if (isLiability(a.type)) {
      liabilities.push(row)
      liabilityTotal += balance
    } else if (ASSET_TYPES.has(a.type ?? '')) {
      assets.push(row)
      assetTotal += balance
    }
    // Unknown types are ignored, matching netWorth().
  }
  return { assets, liabilities, assetTotal, liabilityTotal, net: assetTotal - liabilityTotal }
}

// Category spend record -> rows sorted by amount, largest first.
export function sortedSpendRows(byCat: Record<string, number>): {
  category: string
  amount: number
}[] {
  return Object.entries(byCat)
    .map(([category, amount]) => ({ category, amount }))
    .sort((a, b) => b.amount - a.amount)
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/unit/breakdown.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/breakdown.ts tests/unit/breakdown.test.ts
git commit -m "feat(breakdown): pure helpers to group accounts and sort category spend"
```

---

## Task 2: Make StatCard optionally a link, and link the four tiles

**Files:**
- Modify: `components/ui/StatCard.tsx`, `app/(app)/dashboard/page.tsx`

**Interfaces:**
- Produces: `StatCard` accepts optional `href?: string`; when set, the whole tile is a link to `href`.

- [ ] **Step 1: Read the Next 16 Link guidance**

Skim `node_modules/next/dist/docs/` for `next/link` usage. Confirm `import Link from 'next/link'` and `<Link href=…>`.

- [ ] **Step 2: Add `href` to StatCard**

Replace the contents of `components/ui/StatCard.tsx`:

```tsx
import type { ReactNode } from 'react'
import Link from 'next/link'
import { Card } from './Card'
import { ChevronRightIcon } from './icons'

// A KPI tile: small uppercase label, big number, optional footnote. When `href` is set the whole
// tile becomes a link that drills into a breakdown of the number.
export function StatCard({
  label,
  value,
  foot,
  href,
}: {
  label: string
  value: ReactNode
  foot?: ReactNode
  href?: string
}) {
  const body = (
    <>
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-wide text-faint">{label}</div>
        {href && <ChevronRightIcon className="h-4 w-4 text-faint" />}
      </div>
      <div className="mt-2 text-xl font-semibold tracking-tight tabular-nums text-ink sm:text-2xl lg:text-3xl">
        {value}
      </div>
      {foot != null && <div className="mt-1.5 text-sm">{foot}</div>}
    </>
  )
  if (href) {
    return (
      <Link href={href} className="block">
        <Card className="p-5 transition-colors hover:bg-surface-2">{body}</Card>
      </Link>
    )
  }
  return <Card className="p-5">{body}</Card>
}
```

- [ ] **Step 3: Confirm `ChevronRightIcon` exists; add it if not**

Run: `grep -n "ChevronRightIcon" components/ui/icons.tsx`
If absent, add to `components/ui/icons.tsx` (match the existing icon style — a function returning an `<svg>` taking `className`):

```tsx
export function ChevronRightIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="m9 18 6-6-6-6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
```

- [ ] **Step 4: Point the four tiles at their breakdowns**

In `app/(app)/dashboard/page.tsx`, add `href` to each of the four `StatCard`s:
- Net worth tile → `href="/breakdown/net-worth"`
- Cash on hand tile → `href="/breakdown/cash"`
- Spent tile → `href="/breakdown/spent"`
- Saved this month tile → `href="/breakdown/saved"`

(Add only the `href` prop to each existing `<StatCard …>`; leave all other props unchanged.)

- [ ] **Step 5: Typecheck, lint, build**

Run: `npx tsc --noEmit && npm run lint && npm run build`
Expected: all pass. (The `/breakdown/*` routes 404 until Task 3 — that's fine; the links are strings.)

- [ ] **Step 6: Commit**

```bash
git add components/ui/StatCard.tsx components/ui/icons.tsx "app/(app)/dashboard/page.tsx"
git commit -m "feat(dashboard): make the four KPI tiles drill into a breakdown"
```

---

## Task 3: Breakdown route + shared list

**Files:**
- Create: `components/BreakdownList.tsx`, `app/(app)/breakdown/[metric]/page.tsx`

**Interfaces:**
- Consumes: `groupAccountsByKind`, `sortedSpendRows` (`@/lib/breakdown`); `netWorth`, `cashOnHand` (`@/lib/dashboard`); `spendByCategory`, `monthKey` (`@/lib/budget`); `monthlyFlows`, `lastNMonths` (`@/lib/dashboard`); `pfcToName`, `nonSpendingNames` (`@/lib/categories`); `money` (`@/lib/format`).
- Produces: `BreakdownList({ rows, total })` where `rows: BreakdownRow[]` and `total?: { label: string; amount: number; currency: string }`.

- [ ] **Step 1: Create `components/BreakdownList.tsx`**

```tsx
import Link from 'next/link'
import { money } from '@/lib/format'

export type BreakdownRow = {
  key: string
  label: string
  sub?: string | null
  amount: number
  currency: string
  owed?: boolean
  href?: string
}

// Presentational list for a breakdown page: each row is a label + amount, optionally a drill link.
// A liability (`owed`) renders its amount as a negative in coral, matching AccountCard.
export function BreakdownList({
  rows,
  total,
}: {
  rows: BreakdownRow[]
  total?: { label: string; amount: number; currency: string }
}) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted">Nothing to show here yet.</p>
  }
  return (
    <ul className="divide-y divide-line">
      {rows.map((r) => {
        const amountEl = (
          <span className={`tabular-nums ${r.owed ? 'text-coral' : 'text-ink'}`}>
            {r.owed ? `−${money(r.amount, r.currency)}` : money(r.amount, r.currency)}
          </span>
        )
        const inner = (
          <div className="flex items-center justify-between py-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-ink">{r.label}</p>
              {r.sub && <p className="truncate text-xs text-muted">{r.sub}</p>}
            </div>
            {amountEl}
          </div>
        )
        return (
          <li key={r.key}>
            {r.href ? (
              <Link href={r.href} className="block transition-colors hover:bg-surface-2">
                {inner}
              </Link>
            ) : (
              inner
            )}
          </li>
        )
      })}
      {total && (
        <li className="flex items-center justify-between py-3 font-semibold">
          <span className="text-sm text-ink">{total.label}</span>
          <span className="tabular-nums text-ink">{money(total.amount, total.currency)}</span>
        </li>
      )}
    </ul>
  )
}
```

- [ ] **Step 2: Read the Next 16 dynamic-route guidance**

Skim `node_modules/next/dist/docs/` for dynamic route segments and `notFound()`. Confirm `params` is a Promise (`const { metric } = await params`) and `import { notFound } from 'next/navigation'`.

- [ ] **Step 3: Create `app/(app)/breakdown/[metric]/page.tsx`**

```tsx
import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { BreakdownList, type BreakdownRow } from '@/components/BreakdownList'
import { PageHeader } from '@/components/ui/PageHeader'
import { Card } from '@/components/ui/Card'
import { money } from '@/lib/format'
import { groupAccountsByKind, sortedSpendRows } from '@/lib/breakdown'
import { netWorth, cashOnHand, lastNMonths, monthlyFlows, type FlowTxn } from '@/lib/dashboard'
import { spendByCategory, monthKey, type Txn } from '@/lib/budget'
import {
  pfcToName,
  nonSpendingNames,
  transferNames,
  type Category,
} from '@/lib/categories'

const TITLES: Record<string, { title: string; subtitle: string }> = {
  'net-worth': { title: 'Net worth', subtitle: 'Everything you own, minus what you owe' },
  cash: { title: 'Cash on hand', subtitle: 'Balances in your everyday accounts' },
  spent: { title: 'Spent this month', subtitle: 'Where the money went, by category' },
  saved: { title: 'Saved this month', subtitle: 'Money in versus money out' },
}

export default async function BreakdownPage({ params }: { params: Promise<{ metric: string }> }) {
  const { metric } = await params
  if (!TITLES[metric]) notFound()

  const supabase = await createClient()
  const { data: accountsData } = await supabase.from('accounts').select('*').order('name')
  const accounts = accountsData ?? []
  const currency = accounts[0]?.iso_currency_code ?? 'USD'

  const header = TITLES[metric]
  let rows: BreakdownRow[] = []
  let total: { label: string; amount: number; currency: string } | undefined

  if (metric === 'net-worth') {
    const g = groupAccountsByKind(accounts)
    rows = [
      ...g.assets.map((a) => ({
        key: a.id,
        label: a.name,
        sub: a.subtype,
        amount: a.balance,
        currency,
        owed: false,
        href: `/transactions?account=${encodeURIComponent(a.account_id)}`,
      })),
      ...g.liabilities.map((a) => ({
        key: a.id,
        label: a.name,
        sub: a.subtype,
        amount: a.balance,
        currency,
        owed: true,
        href: `/transactions?account=${encodeURIComponent(a.account_id)}`,
      })),
    ]
    total = { label: 'Net worth', amount: netWorth(accounts), currency }
  } else if (metric === 'cash') {
    // Cash = depository accounts only; reuse cashOnHand() for the total.
    const depository = accounts.filter((a) => a.type === 'depository')
    rows = depository.map((a) => ({
      key: a.id,
      label: a.name ?? 'Account',
      sub: a.subtype,
      amount: a.current_balance ?? 0,
      currency,
      href: `/transactions?account=${encodeURIComponent(a.account_id)}`,
    }))
    total = { label: 'Cash on hand', amount: cashOnHand(accounts), currency }
  } else {
    // spent / saved both need this month's flows
    const { data: cats } = await supabase
      .from('categories')
      .select('id, name, pfc_primary, sort_order')
      .order('sort_order')
    const categories = (cats ?? []) as Category[]
    const pfcMap = pfcToName(categories)
    const nonSpending = nonSpendingNames(categories)
    const transfers = transferNames(categories)

    const now = new Date()
    const months = lastNMonths(now, 6)
    const thisKey = months[months.length - 1].key
    const { data: flowTxns } = await supabase
      .from('transactions')
      .select('amount, date, user_category, pfc_primary, pfc_detailed')
      .eq('removed', false)
      .gte('date', `${thisKey}-01`)
    const monthTxns = ((flowTxns ?? []) as Txn[]).filter((t) => monthKey(t.date) === thisKey)

    if (metric === 'spent') {
      const byCat = spendByCategory(monthTxns, pfcMap, nonSpending)
      rows = sortedSpendRows(byCat).map((r) => ({
        key: r.category,
        label: r.category,
        amount: r.amount,
        currency,
        href: `/transactions?category=${encodeURIComponent(r.category)}&month=${thisKey}`,
      }))
      const spent = rows.reduce((s, r) => s + r.amount, 0)
      total = { label: 'Total spent', amount: spent, currency }
    } else {
      // saved
      const flows = monthlyFlows((flowTxns ?? []) as FlowTxn[], pfcMap, nonSpending, transfers, months)
      const m = flows[flows.length - 1]
      rows = [
        {
          key: 'in',
          label: 'Money in (income)',
          amount: m.income,
          currency,
          href: `/transactions?flow=in&month=${thisKey}`,
        },
        {
          key: 'out',
          label: 'Money out (spending)',
          amount: m.spending,
          currency,
          href: `/transactions?flow=out&month=${thisKey}`,
        },
      ]
      total = { label: 'Saved this month', amount: m.income - m.spending, currency }
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader title={header.title} subtitle={header.subtitle} />
      <Card className="p-5">
        <BreakdownList rows={rows} total={total} />
      </Card>
    </div>
  )
}
```

- [ ] **Step 4: Typecheck, lint, build**

Run: `npx tsc --noEmit && npm run lint && npm run build`
Expected: all pass; build output lists `/breakdown/[metric]`.

- [ ] **Step 5: Commit**

```bash
git add components/BreakdownList.tsx "app/(app)/breakdown/[metric]/page.tsx"
git commit -m "feat(breakdown): drill-down pages for net worth, cash, spent, and saved"
```

---

## Task 4: Filter-aware Transactions page (level 2)

**Files:**
- Modify: `app/(app)/transactions/page.tsx`

**Interfaces:**
- Consumes: `effectiveCategory` (`@/lib/effective-category`); `isCreditCardPayment`, `nonSpendingNames`, `transferNames` (`@/lib/categories`).
- Produces: `/transactions` honors `account`, `category`, `month`, `flow` (`in`|`out`) in addition to `q`, and shows a chip describing the active filter with a clear-filter link.

- [ ] **Step 1: Read current transactions page**

Run: `sed -n '1,90p' "app/(app)/transactions/page.tsx"` and note: it awaits `searchParams` for `q`, builds `pfcMap`, queries the 200 most recent, renders `TransactionRow`s.

- [ ] **Step 2: Add the filters**

In `app/(app)/transactions/page.tsx`:

1. Widen the `searchParams` type and destructure the new params:

```tsx
export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string
    account?: string
    category?: string
    month?: string
    flow?: string
  }>
}) {
  const { q, account, category, month, flow } = await searchParams
```

2. After `const safe = …`, add the SQL-level filters to the query builder (these are the ones Postgres can do directly). Replace the existing query construction with:

```tsx
  let query = supabase
    .from('transactions')
    .select('id, name, merchant_name, amount, date, user_category, pfc_primary, pfc_detailed, account_id')
    .eq('removed', false)
    .order('date', { ascending: false })
    .limit(200)
  if (safe) query = query.or(`name.ilike.%${safe}%,merchant_name.ilike.%${safe}%`)
  if (account) query = query.eq('account_id', account)
  if (month) {
    // month is 'YYYY-MM'; bound to [first of month, first of next month)
    const [y, m] = month.split('-').map(Number)
    const start = `${month}-01`
    const nextY = m === 12 ? y + 1 : y
    const nextM = m === 12 ? 1 : m + 1
    const end = `${nextY}-${String(nextM).padStart(2, '0')}-01`
    query = query.gte('date', start).lt('date', end)
  }
  const { data: txns } = await query
  let list = txns ?? []
```

3. Category and flow filters are on the transaction's *effective* category, which is computed — so filter them in memory after the query, above the render. Add:

```tsx
  // category / flow filter on the effective category (computed, so filtered in memory)
  if (category) {
    list = list.filter((t) => effectiveCategory(t, pfcMap) === category)
  }
  if (flow === 'in' || flow === 'out') {
    const nonSpending = nonSpendingNames(categories) // income + transfers
    const transfers = transferNames(categories)
    list = list.filter((t) => {
      if (isCreditCardPayment(t)) return false
      const cat = effectiveCategory(t, pfcMap)
      if (transfers.has(cat)) return false
      const isIncomeCat = nonSpending.has(cat) && !transfers.has(cat)
      return flow === 'in' ? isIncomeCat : !isIncomeCat
    })
  }
```

4. Add the imports at the top:

```tsx
import { pfcToName, nonSpendingNames, transferNames, type Category } from '@/lib/categories'
import { isCreditCardPayment } from '@/lib/categories'
```

(Keep the existing `effectiveCategory` import; if `pfcToName`/`Category` are already imported, don't duplicate — merge into one import line.)

5. Add a filter chip above the results. Just under the `<PageHeader … />`, add:

```tsx
      {(account || category || (month && flow) || flow) && (
        <div className="flex items-center gap-2 text-sm">
          <span className="rounded-full bg-emerald-050 px-3 py-1 text-emerald-600">
            {account
              ? 'Filtered to one account'
              : category
                ? `Category: ${category}${month ? ` · ${month}` : ''}`
                : flow === 'in'
                  ? `Money in · ${month}`
                  : `Money out · ${month}`}
          </span>
          <a href="/transactions" className="text-muted hover:text-ink">
            Clear
          </a>
        </div>
      )}
```

- [ ] **Step 3: Typecheck, lint, build**

Run: `npx tsc --noEmit && npm run lint && npm run build`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add "app/(app)/transactions/page.tsx"
git commit -m "feat(transactions): filter by account, category, month, and flow for drill-down"
```

---

## Task 5: Manual verification

- [ ] **Step 1: Run the app and click through each drill-down**

`npm run dev`, sign in, and from the dashboard:
1. Click **Net worth** → confirm assets and liabilities are grouped, the net matches the tile. Click an asset account → lands on `/transactions?account=…` showing that account's transactions. Click the **mortgage** (a liability, balances-only) → confirm the transactions list is empty and readable (no crash).
2. Click **Cash on hand** → depository accounts, total matches the tile. Drill one account.
3. Click **Spent in <month>** → categories sorted high to low, total matches the tile. Click a category → `/transactions?category=…&month=…` showing that category this month.
4. Click **Saved this month** → Money in / Money out rows and net match the tile. Click each → filtered transactions.
5. On any filtered transactions view, confirm the chip shows the filter and **Clear** returns to the full list.

- [ ] **Step 2: Confirm totals reconcile**

For at least Spent and Cash, confirm the breakdown total equals the dashboard tile to the cent.

- [ ] **Step 3: Commit any copy/polish fixes discovered**

```bash
git add -A && git commit -m "fix(breakdown): polish from manual verification"
```

---

## Final verification

- [ ] `npx vitest run` — all pass, including `tests/unit/breakdown.test.ts`.
- [ ] `npx tsc --noEmit && npm run lint && npm run build && npm run check:secrets` — all clean.
- [ ] Manual click-through (Task 5) done for all four tiles, including the balances-only mortgage and an empty category.
- [ ] Open a PR from `feature/dashboard-drill-down` (closes #24).
