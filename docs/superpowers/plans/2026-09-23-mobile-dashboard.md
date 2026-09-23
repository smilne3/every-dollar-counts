# Mobile Dashboard (Stage 2 of the Phone Pass) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the dashboard readable on a phone — net worth as a full-width hero that cannot clip, the other three figures rounded across one row, accounts collapsed behind a "Show all" control — and retire the last copy of the transaction presentation rules.

**Architecture:** `StatCard` gains a `variant` and starts taking the *number* rather than a pre-formatted string, so the rounding rule lives in the tile instead of at four call sites. Because one server-rendered HTML output has to serve both viewports, a compact tile emits both strings and CSS picks: rounded below `md`, exact from `md` up. Desktop layout is untouched. Separately, `RecentActivity` and the dashboard's `recentItems` mapping both stop re-deriving what `presentTransaction` already knows.

**Tech Stack:** Next.js 16.3.5 (App Router, React 19.3.0 server components), Tailwind, Vitest + @testing-library/react, jsdom.

**Spec:** `docs/superpowers/specs/2026-09-22-mobile-pass-design.md` — §4 is this stage; §1.3 is the defect it closes; §9 lists the tests it owes.

## Global Constraints

- **Breakpoint is `md`.** Below `md` is the phone layout; `md` and up is today's desktop layout, unchanged. Stage 1 set this and stage 2 does not re-decide it.
- **Rounding is display-only.** It happens inside `StatCard`, never in the value passed to it, and never at or above `md`. No stored or computed figure is ever rounded.
- **Net worth is always exact, at every width.** It is the figure that clipped twice (§1.3); rounding it would hide the problem rather than fix it.
- **Desktop output must not change.** Above `md` the four tiles keep `lg:grid-cols-4`, exact figures and today's type scale. Any diff visible at desktop width is a bug in this stage.
- **`presentTransaction` is the single source of transaction meaning.** After Task 5 no other file flips the Plaid sign, re-derives the merchant-name fallback, or re-implements the tone mapping.
- **Verify before claiming done:** `npx vitest run`, `npx tsc --noEmit`, `npm run lint`, `npm run build`, `npm run check:invariants`.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `lib/format.ts` | Add `moneyWhole()` — the one place a figure is rounded for display | 1 |
| `components/ui/StatCard.tsx` | Takes `amount` + `variant`; owns the hero/compact type scale and the dual-string rounding | 2 |
| `app/(app)/dashboard/page.tsx` | Hero + row-of-three below `md`; selects `reimbursable_amount`; maps `recentItems` via `presentTransaction` | 3, 5 |
| `components/AccountList.tsx` | **New.** Client component: first 4 accounts with a "Show all N" control below `md`, all of them from `md` up | 4 |
| `components/RecentActivity.tsx` | Renders from presented values; keeps its own icon palette | 5 |
| `lib/transaction-presentation.ts` | Comment only — retract the "known third copy" note | 5 |

Tasks 1→2→3 are a chain. Task 4 and Task 5 are independent of each other and of the chain; either may be done in any order after Task 1.

---

### Task 1: `moneyWhole()` — one place that rounds

**Files:**
- Modify: `lib/format.ts:1-3`
- Test: `tests/unit/format.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `moneyWhole(amount: number | null | undefined, currency?: string): string` — the same shape as `money()` but with no cents. `moneyWhole(34920.49)` → `"$34,920"`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/format.test.ts`:

```ts
describe('moneyWhole', () => {
  // The three compact tiles round for width. Cents on a phone buy nothing and cost the
  // characters that made §1.3 clip.
  it('drops the cents', () => {
    expect(moneyWhole(34920.49)).toBe('$34,920')
    expect(moneyWhole(8776.51)).toBe('$8,777')
  })

  // Rounding is for READING. A figure that rounds to nothing must not read as nothing at all,
  // so the currency symbol and the sign both survive.
  it('keeps the sign and the symbol on a negative figure', () => {
    expect(moneyWhole(-5449)).toBe('-$5,449')
  })

  it('renders zero as zero, not as an empty string', () => {
    expect(moneyWhole(0)).toBe('$0')
  })

  // money() already treats null as zero; the rounded form must not disagree with it.
  it('treats null and undefined as zero, exactly as money() does', () => {
    expect(moneyWhole(null)).toBe('$0')
    expect(moneyWhole(undefined)).toBe('$0')
  })

  it('honours a non-default currency', () => {
    expect(moneyWhole(1200, 'EUR')).toBe('€1,200')
  })
})
```

Add `moneyWhole` to the existing import at the top of the file.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run tests/unit/format.test.ts`
Expected: FAIL — `moneyWhole is not a function` / import error.

- [ ] **Step 3: Implement it**

In `lib/format.ts`, directly below `money()`:

```ts
// money() without the cents, for the compact tiles below `md` (spec §4). Rounding is a DISPLAY
// choice made in StatCard and nowhere else: no stored figure, no computed total and nothing at or
// above `md` ever passes through here. Intl rounds half-away-from-zero, which is what a reader
// glancing at a tile expects.
export function moneyWhole(amount: number | null | undefined, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(amount ?? 0)
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run tests/unit/format.test.ts`
Expected: PASS, all of them.

- [ ] **Step 5: Commit**

```bash
git add lib/format.ts tests/unit/format.test.ts
git commit -m "Add moneyWhole, the one place a figure is rounded for display"
```

---

### Task 2: `StatCard` gains `hero` and `compact`

**Files:**
- Modify: `components/ui/StatCard.tsx` (whole file)
- Test: `tests/unit/stat-card.test.tsx` (new)

**Interfaces:**
- Consumes: `moneyWhole` from Task 1.
- Produces:

```ts
StatCard({
  label: string,
  amount: number,
  currency?: string,          // default 'USD'
  variant?: 'hero' | 'compact', // default 'compact'
  tone?: 'ink' | 'coral',     // default 'ink' — colours the figure
  foot?: ReactNode,
  href?: string,
})
```

`value: ReactNode` is **removed**. All four call sites pass money and are updated in Task 3; there are no other consumers.

**Why both strings are rendered:** the page is one server-rendered HTML document serving both viewports, so the choice cannot be made in JS. A compact tile emits the rounded figure with `md:hidden` and the exact figure with `hidden md:inline`. Tailwind's `hidden` is `display:none`, which also removes the node from the accessibility tree, so a screen reader hears exactly one figure. This mirrors how stage 1 ships both transaction layouts.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/stat-card.test.tsx`:

```tsx
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { StatCard } from '@/components/ui/StatCard'

afterEach(cleanup)

// The §9 assertion: a formatting test, not a width one. This is the test that would have caught
// §1.3 regressing, because the tile — not the caller — now decides how many characters it shows.
describe('StatCard', () => {
  it('renders the hero figure exactly, cents and all', () => {
    render(<StatCard label="Net worth" amount={1182885.15} variant="hero" />)
    expect(screen.getByText('$1,182,885.15')).toBeTruthy()
  })

  // Net worth is the figure that clipped twice. It must never be the rounded one.
  it('never rounds the hero figure', () => {
    render(<StatCard label="Net worth" amount={1182885.15} variant="hero" />)
    expect(screen.queryByText('$1,182,885')).toBeNull()
  })

  // A compact tile carries BOTH: the rounded one for the phone, the exact one from md up. CSS
  // decides which is seen, so both are in the DOM and each must be the right string.
  it('carries a rounded figure and an exact one on a compact tile', () => {
    render(<StatCard label="Cash on hand" amount={34920.49} />)
    expect(screen.getByText('$34,920')).toBeTruthy()
    expect(screen.getByText('$34,920.49')).toBeTruthy()
  })

  it('hides the rounded figure from md up and the exact figure below it', () => {
    render(<StatCard label="Cash on hand" amount={34920.49} />)
    expect(screen.getByText('$34,920').className).toContain('md:hidden')
    expect(screen.getByText('$34,920.49').className).toContain('hidden')
  })

  it('defaults to compact when no variant is given', () => {
    render(<StatCard label="Spent" amount={8776.51} />)
    expect(screen.getByText('$8,777')).toBeTruthy()
  })

  it('names the tile', () => {
    render(<StatCard label="Saved this month" amount={5449} />)
    expect(screen.getByText('Saved this month')).toBeTruthy()
  })

  // The "Saved this month" tile turns red when negative. That rule used to live in the caller's
  // JSX, which is why the caller had to pre-format the figure in the first place.
  //
  // Asserted on `hero`, where the figure is a direct child of the toned wrapper. On a compact tile
  // getByText returns the inner md:hidden/hidden span, which carries no tone — the tone is declared
  // once on the wrapper so the rounded and exact strings cannot end up different colours.
  it('paints a coral figure when asked', () => {
    render(<StatCard label="Saved" amount={-120} variant="hero" tone="coral" />)
    expect(screen.getByText('-$120.00').className).toContain('text-coral')
  })

  it('renders a footnote when given one', () => {
    render(<StatCard label="Net worth" amount={10} foot={<span>Across 12 accounts</span>} />)
    expect(screen.getByText('Across 12 accounts')).toBeTruthy()
  })

  it('becomes a link when given an href', () => {
    render(<StatCard label="Cash" amount={10} href="/breakdown/cash" />)
    expect(screen.getByRole('link').getAttribute('href')).toBe('/breakdown/cash')
  })
})
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run tests/unit/stat-card.test.tsx`
Expected: FAIL — the component still expects `value`, so nothing renders the figures.

- [ ] **Step 3: Rewrite the component**

Replace `components/ui/StatCard.tsx` entirely:

```tsx
import type { ReactNode } from 'react'
import Link from 'next/link'
import { Card } from './Card'
import { ChevronRightIcon } from './icons'
import { money, moneyWhole } from '@/lib/format'

// A KPI tile: small uppercase label, big number, optional footnote. When `href` is set the whole
// tile becomes a link that drills into a breakdown of the number.
//
// Takes the NUMBER, not a formatted string. It used to take a ReactNode, which meant each of the
// four callers picked its own formatting and its own type size — and when the net worth tile
// clipped (§1.3) the fix had to be guessed at from the outside. The tile owns both now, so the
// rounding rule is in one place and the §9 formatting test has something to assert against.
export function StatCard({
  label,
  amount,
  currency = 'USD',
  variant = 'compact',
  tone = 'ink',
  foot,
  href,
}: {
  label: string
  amount: number
  currency?: string
  // `hero`: full width, exact, largest type — for the figure that must never be abbreviated.
  // `compact`: rounded below `md` where the width is not there, exact from `md` up.
  variant?: 'hero' | 'compact'
  tone?: 'ink' | 'coral'
  foot?: ReactNode
  href?: string
}) {
  const toneClass = tone === 'coral' ? 'text-coral' : 'text-ink'
  const figureClass = `mt-2 font-semibold tracking-tight tabular-nums ${toneClass} ${
    variant === 'hero' ? 'text-3xl md:text-2xl lg:text-3xl' : 'text-xl sm:text-2xl lg:text-3xl'
  }`

  const body = (
    <>
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-wide text-faint">{label}</div>
        {href && <ChevronRightIcon className="h-4 w-4 text-faint" />}
      </div>
      <div className={figureClass}>
        {variant === 'hero' ? (
          // Always exact. This is the figure §1.3 is about: it is given the whole width precisely
          // so that no character count can ever clip it again.
          money(amount, currency)
        ) : (
          // One server-rendered document serves both viewports, so the choice cannot be made in
          // JS. Both strings ship and CSS picks. `hidden` is display:none, so the one that is not
          // shown is also out of the accessibility tree — a screen reader hears one figure.
          <>
            <span className="md:hidden">{moneyWhole(amount, currency)}</span>
            <span className="hidden md:inline">{money(amount, currency)}</span>
          </>
        )}
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

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run tests/unit/stat-card.test.tsx`
Expected: PASS, all nine.

`npx tsc --noEmit` will now fail in `app/(app)/dashboard/page.tsx` — four call sites still pass `value`. Task 3 fixes them. That is expected and is why these two tasks are adjacent.

- [ ] **Step 5: Commit**

```bash
git add components/ui/StatCard.tsx tests/unit/stat-card.test.tsx
git commit -m "Give StatCard a hero and a compact variant, and the number to format"
```

---

### Task 3: The dashboard leads with net worth

**Files:**
- Modify: `app/(app)/dashboard/page.tsx:236-273` (the tile grid)
- Test: `tests/unit/dashboard-page.test.tsx`

**Interfaces:**
- Consumes: `StatCard` from Task 2.
- Produces: no new exports.

**Layout:** below `md`, net worth is a full-width hero and the other three sit in one row of three. From `md` up, the existing four-across grid is unchanged. Two containers rather than one grid with span overrides, because the hero and the row have genuinely different track counts and a single grid would need a `col-span` that only applies at one breakpoint.

- [ ] **Step 1: Write the failing tests**

Append inside the existing `describe('Dashboard reads', ...)` in `tests/unit/dashboard-page.test.tsx`:

```ts
  // §4: the tiles are treated by importance, not equally. jsdom does no layout, so what is
  // decidable here is that the hero tile exists and carries the figure that clipped twice.
  it('gives net worth the hero tile', async () => {
    results.accounts = {
      data: [{ id: 'a1', type: 'depository', current_balance: 1182885.15 }],
      error: null,
    }
    const tree = await render()
    const hero = findStatCards(tree).find((c) => c.props.label === 'Net worth')
    expect(hero).toBeTruthy()
    expect(hero!.props.variant).toBe('hero')
  })

  // The other three round below md, which is what buys the width to fit three across.
  it('leaves the other three tiles compact', async () => {
    const labels = findStatCards(await render())
      .filter((c) => c.props.variant !== 'hero')
      .map((c) => c.props.label)
    expect(labels).toContain('Cash on hand')
    expect(labels).toContain('Saved this month')
    expect(labels.some((l: string) => l.startsWith('Spent in'))).toBe(true)
  })

  // Rounding is display-only. The tile is handed the real figure and decides for itself; a
  // pre-rounded value here would round the desktop layout too.
  it('hands the tiles unrounded figures', async () => {
    results.accounts = {
      data: [{ id: 'a1', type: 'depository', current_balance: 34920.49 }],
      error: null,
    }
    const cash = findStatCards(await render()).find((c) => c.props.label === 'Cash on hand')
    expect(cash!.props.amount).toBeCloseTo(34920.49, 2)
  })
```

And add this helper next to `textOf`:

```ts
// Collect the StatCard elements from the returned tree so tile assertions can read their props
// directly. textOf() deliberately flattens to strings, which cannot see a `variant` or an `amount`.
type StatCardProps = { label: string; amount: number; variant?: 'hero' | 'compact' }

function findStatCards(node: unknown): { props: StatCardProps }[] {
  const found: { props: StatCardProps }[] = []
  const walk = (n: unknown) => {
    if (n == null || typeof n !== 'object') return
    if (Array.isArray(n)) {
      n.forEach(walk)
      return
    }
    const el = n as { type?: unknown; props?: { children?: unknown } }
    if (typeof el.type === 'function' && (el.type as { name?: string }).name === 'StatCard') {
      found.push(el as unknown as { props: StatCardProps })
    }
    if (el.props?.children) walk(el.props.children)
  }
  walk(node)
  return found
}
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run tests/unit/dashboard-page.test.tsx`
Expected: FAIL — no tile has a `variant`, and `amount` is undefined because the page still passes `value`.

- [ ] **Step 3: Rewrite the tile block**

Replace `app/(app)/dashboard/page.tsx:236-273` (from `<div className="grid grid-cols-2 gap-4 lg:grid-cols-4">` through its closing `</div>`) with:

```tsx
      {/* Net worth leads (§4). Below `md` it is a full-width hero and the other three share one
          row; from `md` up this is the four-across grid it has always been. Two containers rather
          than one grid, because the hero and the row have different track counts and a single
          grid would need a col-span that applies at exactly one breakpoint. */}
      <div className="space-y-4 md:grid md:grid-cols-2 md:gap-4 md:space-y-0 lg:grid-cols-4">
        <StatCard
          label="Net worth"
          amount={worth}
          currency={currency}
          variant="hero"
          href="/breakdown/net-worth"
          foot={
            <span className="text-muted">
              Across {accounts.length} account{accounts.length === 1 ? '' : 's'}
            </span>
          }
        />
        {/* The three supporting figures. `contents` from `md` up so they become direct children of
            the grid above and take their own tracks, rather than sitting inside a nested box. */}
        <div className="grid grid-cols-3 gap-3 md:contents">
          <StatCard
            label="Cash on hand"
            amount={cash}
            currency={currency}
            href="/breakdown/cash"
            foot={
              <span className="text-muted">
                In {depCount} account{depCount === 1 ? '' : 's'}
              </span>
            }
          />
          <StatCard
            label={`Spent in ${thisMonthLabel}`}
            amount={spent}
            currency={currency}
            href="/breakdown/spent"
            foot={budgetFoot}
          />
          <StatCard
            label="Saved this month"
            amount={saved}
            currency={currency}
            tone={saved < 0 ? 'coral' : 'ink'}
            href="/breakdown/saved"
            foot={
              <span className="text-muted">
                {money(income, currency)} in · {money(spent, currency)} out
              </span>
            }
          />
        </div>
      </div>
```

- [ ] **Step 4: Run the tests and the typechecker**

Run: `npx vitest run tests/unit/dashboard-page.test.tsx && npx tsc --noEmit`
Expected: tests PASS; `tsc` exits 0 now that every call site passes `amount`.

- [ ] **Step 5: Commit**

```bash
git add "app/(app)/dashboard/page.tsx" tests/unit/dashboard-page.test.tsx
git commit -m "Lead the dashboard with net worth on a phone"
```

---

### Task 4: Accounts collapse behind "Show all N"

**Files:**
- Create: `components/AccountList.tsx`
- Modify: `app/(app)/dashboard/page.tsx:316-323` (the accounts section)
- Test: `tests/unit/account-list.test.tsx` (new)

**Interfaces:**
- Consumes: `AccountCard` (existing, unchanged).
- Produces: `AccountList({ accounts }: { accounts: Account[] })`, where `Account` is the same row type `AccountCard` already accepts. Import that type from wherever `AccountCard` declares it rather than redeclaring it.

**Why a client component:** the control has state. It is the smallest possible island — the page stays a server component and passes rows in.

**Behaviour:** below `md`, the first 4 render and a "Show all N" button reveals the rest; once expanded it reads "Show fewer". From `md` up every account renders and the button is not shown, because the desktop grid has the room and this stage must not change desktop.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/account-list.test.tsx`:

```tsx
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { AccountList } from '@/components/AccountList'

afterEach(cleanup)

const accounts = Array.from({ length: 12 }, (_, i) => ({
  id: `a${i}`,
  name: `Account ${i}`,
  type: 'depository',
  current_balance: 100 + i,
  iso_currency_code: 'USD',
}))

describe('AccountList', () => {
  // Accounts are reference material, not the reason the page was opened (§4). Twelve cards is a
  // lot of thumb between the reader and the end of the page.
  //
  // Asserted on the wrapper's class, not on absence: every card stays in the document at every
  // width so the desktop grid is byte-for-byte what it was (a Global Constraint), and `hidden`
  // below `md` keeps the extras out of the phone list and out of the accessibility tree. Same
  // shape as StatCard's dual strings in Task 2.
  const wrapperOf = (name: string) => screen.getByText(name).closest('[data-account-extra]')

  it('shows the first four outright', () => {
    render(<AccountList accounts={accounts} />)
    expect(screen.getByText('Account 0')).toBeTruthy()
    expect(screen.getByText('Account 3')).toBeTruthy()
    expect(wrapperOf('Account 3')).toBeNull() // not an "extra" — always visible
  })

  it('keeps the rest out of the phone list until asked', () => {
    render(<AccountList accounts={accounts} />)
    expect(wrapperOf('Account 4')!.className).toContain('hidden')
    expect(wrapperOf('Account 4')!.className).toContain('md:contents')
  })

  // N is whatever the household actually has, not a hardcoded twelve.
  it('counts the accounts it is hiding in the control', () => {
    render(<AccountList accounts={accounts} />)
    expect(screen.getByRole('button', { name: 'Show all 12' })).toBeTruthy()
  })

  it('reveals the rest when the control is used', () => {
    render(<AccountList accounts={accounts} />)
    fireEvent.click(screen.getByRole('button', { name: 'Show all 12' }))
    expect(wrapperOf('Account 11')!.className).not.toContain('hidden')
  })

  it('offers a way back once expanded', () => {
    render(<AccountList accounts={accounts} />)
    fireEvent.click(screen.getByRole('button', { name: 'Show all 12' }))
    expect(screen.getByRole('button', { name: 'Show fewer' })).toBeTruthy()
  })

  // Four or fewer is already the whole list, so a control that reveals nothing must not appear.
  it('offers no control when everything is already shown', () => {
    render(<AccountList accounts={accounts.slice(0, 4)} />)
    expect(screen.queryByRole('button', { name: /Show all/ })).toBeNull()
  })

  it('renders nothing rather than an empty shell when there are no accounts', () => {
    const { container } = render(<AccountList accounts={[]} />)
    expect(container.firstChild).toBeNull()
  })
})
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run tests/unit/account-list.test.tsx`
Expected: FAIL — `components/AccountList` does not exist.

- [ ] **Step 3: Write the component**

Create `components/AccountList.tsx`. Import the account row type from `AccountCard` rather than restating it — read `components/AccountCard.tsx` first and use whatever it exports; if it declares the type inline, export it from there and import it here in the same commit.

```tsx
'use client'

import { useState, type ComponentProps } from 'react'
import { AccountCard } from './AccountCard'

// How many accounts are worth the thumb below `md`. Accounts are reference material rather than
// the reason the page was opened (§4), and the household has twelve.
const COLLAPSED = 4

type Account = ComponentProps<typeof AccountCard>['account']

export function AccountList({ accounts }: { accounts: Account[] }) {
  const [expanded, setExpanded] = useState(false)
  if (accounts.length === 0) return null

  // Below `md` the list is cut to COLLAPSED until asked; from `md` up the grid has the room and
  // this stage does not touch desktop, so every card is rendered and the extras are revealed with
  // CSS rather than being absent from the document.
  const hidden = accounts.slice(COLLAPSED)
  const canCollapse = hidden.length > 0

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {accounts.slice(0, COLLAPSED).map((a) => (
          <AccountCard key={a.id} account={a} />
        ))}
        {hidden.map((a) => (
          // Present in the document at every width so the desktop grid is byte-for-byte what it
          // was; `hidden` below `md` keeps them out of the phone list AND out of the
          // accessibility tree until the reader asks.
          <div
            key={a.id}
            data-account-extra
            className={expanded ? 'contents' : 'hidden md:contents'}
          >
            <AccountCard account={a} />
          </div>
        ))}
      </div>
      {canCollapse && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-sm font-medium text-emerald hover:text-emerald-600 md:hidden"
        >
          {expanded ? 'Show fewer' : `Show all ${accounts.length}`}
        </button>
      )}
    </div>
  )
}
```

The `data-account-extra` attribute exists for the tests: it is how a test tells a collapsed card from an always-visible one without depending on where the wrapper sits in the markup.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run tests/unit/account-list.test.tsx`
Expected: PASS once the assertions and the implementation agree per the note above.

- [ ] **Step 5: Use it from the page**

Replace `app/(app)/dashboard/page.tsx:316-323` with:

```tsx
      <div className="space-y-3">
        <h2 className="text-base font-semibold text-ink">Accounts</h2>
        <AccountList accounts={accounts} />
      </div>
```

Add `import { AccountList } from '@/components/AccountList'` and drop the now-unused `AccountCard` import from the page.

- [ ] **Step 6: Run the whole suite**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add components/AccountList.tsx tests/unit/account-list.test.tsx "app/(app)/dashboard/page.tsx"
git commit -m "Collapse the account list behind Show all on a phone"
```

---

### Task 5: Retire the third copy of the presentation rules

**Files:**
- Modify: `components/RecentActivity.tsx` (whole file)
- Modify: `app/(app)/dashboard/page.tsx:160-178` (the recent query and `recentItems`)
- Modify: `lib/transaction-presentation.ts:8-13` (comment)
- Test: `tests/unit/recent-activity.test.tsx`

**Interfaces:**
- Consumes: `presentTransaction`, `PresentedTxn`, `TONE_CLASS` from `lib/transaction-presentation.ts`.
- Produces: `ActivityItem` becomes:

```ts
export type ActivityItem = {
  id: string
  date: string
  category: string
  // Straight from presentTransaction — the list no longer re-derives any of these.
  label: string
  display: number
  tone: PresentedTxn['tone']
  isCC: boolean
}
```

**What is being removed:** `RecentActivity.tsx:25` flips the Plaid sign itself; `:52` re-implements the `TONE_CLASS` mapping; `page.tsx:170` re-implements the merchant-name fallback; `page.tsx:177` calls `isCreditCardPayment` separately. All four are already decided by `presentTransaction`.

**What is being kept:** the icon's three-colour palette (`RecentActivity.tsx:30-36`) is *not* `TONE_CLASS` — an outflow is `coral` on the icon but `text-ink` on the figure. That is a presentation choice belonging to this list and it stays here, keyed off the shared `tone` rather than off a second sign derivation.

- [ ] **Step 1: Write the failing tests**

Replace the body of `tests/unit/recent-activity.test.tsx`, keeping its imports, with tests built on the new shape:

```tsx
import { presentTransaction } from '@/lib/transaction-presentation'

// Build items the way the page does, so the test exercises the real seam rather than a
// hand-written fixture that could drift from it.
const item = (over: Partial<Parameters<typeof presentTransaction>[0]> & { id?: string } = {}) => {
  const txn = {
    amount: 42,
    name: 'JOE S DEN',
    merchant_name: 'Joe S Den',
    user_category: null,
    pfc_detailed: null,
    reimbursable_amount: null,
    ...over,
  }
  const p = presentTransaction(txn)
  return {
    id: over.id ?? 't1',
    date: '2026-08-29',
    category: 'Food',
    label: p.label,
    display: p.display,
    tone: p.tone,
    isCC: p.isCC,
  }
}

describe('RecentActivity', () => {
  it('shows real income as arriving', () => {
    render(<RecentActivity items={[item({ amount: -1200 })]} />)
    expect(screen.getByText('+$1,200.00')).toBeTruthy()
  })

  it('does not dress a credit-card payment up as income', () => {
    render(
      <RecentActivity
        items={[item({ amount: -7866.69, pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' })]}
      />
    )
    expect(screen.queryByText('+$7,866.69')).toBeNull()
    expect(screen.getByText('$7,866.69')).toBeTruthy()
  })

  it('says a card payment is between your own accounts rather than naming a category', () => {
    render(
      <RecentActivity
        items={[item({ amount: -7866.69, pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' })]}
      />
    )
    expect(screen.getByText(/Between your accounts/)).toBeTruthy()
  })

  // The point of the fold: the list takes the merchant-name fallback from presentTransaction
  // rather than owning a fourth copy of it.
  it('names a transaction with no merchant the way every other surface does', () => {
    render(<RecentActivity items={[item({ merchant_name: null, name: null })]} />)
    expect(screen.getByText('Transaction')).toBeTruthy()
  })

  it('tones an outflow, an inflow and a card payment the way TONE_CLASS says', () => {
    render(
      <RecentActivity
        items={[
          item({ id: 'out', amount: 42 }),
          item({ id: 'in', amount: -42 }),
          item({ id: 'cc', amount: -42, pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' }),
        ]}
      />
    )
    expect(screen.getByText('-$42.00').className).toContain(TONE_CLASS.out)
    expect(screen.getByText('+$42.00').className).toContain(TONE_CLASS.in)
    expect(screen.getByText('$42.00').className).toContain(TONE_CLASS.neutral)
  })

  it('says so when there is nothing to show', () => {
    render(<RecentActivity items={[]} />)
    expect(screen.getByText('No transactions yet.')).toBeTruthy()
  })
})
```

Add `TONE_CLASS` to the imports.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run tests/unit/recent-activity.test.tsx`
Expected: FAIL — `ActivityItem` has no `label`/`display`/`tone`, and the component still reads `t.name` and `t.amount`.

- [ ] **Step 3: Rewrite the component**

Replace `components/RecentActivity.tsx`:

```tsx
import { money, shortDate } from '@/lib/format'
import { TONE_CLASS, type PresentedTxn } from '@/lib/transaction-presentation'
import { ArrowUpRightIcon, ArrowDownLeftIcon } from './ui/icons'

// Already presented by the caller. This list used to flip the Plaid sign and re-implement the tone
// mapping itself, which made it the third place those rules lived — see the note this removes from
// lib/transaction-presentation.ts.
export type ActivityItem = {
  id: string
  date: string
  category: string
  label: string
  display: number
  tone: PresentedTxn['tone']
  isCC: boolean
}

// The icon's palette is NOT TONE_CLASS and deliberately so: an outflow is coral in the icon but
// `text-ink` in the figure, because the icon is a glyph on a tinted chip and the figure is text in
// a column. Keyed off the shared `tone` so it cannot disagree about WHAT a row is, only about how
// this one list draws it.
const ICON_CLASS: Record<PresentedTxn['tone'], string> = {
  out: 'bg-coral-050 text-coral',
  in: 'bg-emerald-050 text-emerald',
  neutral: 'bg-surface-2 text-faint',
}

export function RecentActivity({ items }: { items: ActivityItem[] }) {
  if (items.length === 0) {
    return <p className="text-sm text-muted">No transactions yet.</p>
  }
  return (
    <ul className="divide-y divide-line">
      {items.map((t) => (
        <li key={t.id} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
          <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${ICON_CLASS[t.tone]}`}>
            {t.display > 0 ? (
              <ArrowDownLeftIcon className="h-4 w-4" />
            ) : (
              <ArrowUpRightIcon className="h-4 w-4" />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-ink">{t.label}</div>
            <div className="truncate text-xs text-muted">
              {t.isCC ? 'Between your accounts' : t.category} · {shortDate(t.date)}
            </div>
          </div>
          <div className={`shrink-0 text-sm font-medium tabular-nums ${TONE_CLASS[t.tone]}`}>
            {t.tone === 'in' ? '+' : ''}
            {money(t.display)}
          </div>
        </li>
      ))}
    </ul>
  )
}
```

Note `money(t.display)` renders the sign itself, so an outflow reads `-$42.00`; only the `in` tone gets an explicit `+`, and a card payment gets neither, exactly as before.

- [ ] **Step 4: Rewrite the page's mapping**

In `app/(app)/dashboard/page.tsx`, add `reimbursable_amount` to the recent-transactions select at line 162 — `presentTransaction` requires it and throws on a value it cannot read, which is the guard the dashboard has never had:

```ts
    .select('id, name, merchant_name, amount, date, user_category, pfc_primary, pfc_detailed, reimbursable_amount')
```

Then replace the `recentItems` map:

```tsx
  const recentItems = (recentTxns ?? []).map((t) => {
    // One source of meaning. The label fallback and the card-payment call used to be made here,
    // independently of presentTransaction, which is exactly the duplication that module exists to
    // end. `shareAmount` is unused by this list — it shows no reimbursable state.
    const p = presentTransaction(t as Parameters<typeof presentTransaction>[0])
    return {
      id: t.id as string,
      date: t.date as string,
      category: effectiveCategory(t, pfcMap),
      label: p.label,
      display: p.display,
      tone: p.tone,
      isCC: p.isCC,
    }
  })
```

Add `presentTransaction` to the imports. Remove the `isCreditCardPayment` import if nothing else on the page uses it — check first with `grep -n isCreditCardPayment "app/(app)/dashboard/page.tsx"`.

- [ ] **Step 5: Retract the comment that says this was not done**

In `lib/transaction-presentation.ts`, replace the paragraph at lines 8-13 (`Scoped to that pair deliberately…` through `…has to change that file too.`) with:

```ts
// components/RecentActivity.tsx consumes this too, as of stage 2 of the phone pass. It renders a
// different, dashboard-sized list and keeps its own icon palette — an outflow is coral there and
// `text-ink` here — but it no longer flips the sign or decides what a card payment is. Those
// answers come from this module, so a change to the rules below reaches every surface.
```

Also update the first paragraph, which still says "for those two": it is now every surface that renders a transaction.

- [ ] **Step 6: Run the whole suite and the typechecker**

Run: `npx vitest run && npx tsc --noEmit && npm run lint`
Expected: all green. If `dashboard-page.test.tsx` fails on the recent-transactions fixture, it is because the stub rows now flow through `presentTransaction` — give them a `reimbursable_amount: null` rather than loosening the guard.

- [ ] **Step 7: Commit**

```bash
git add components/RecentActivity.tsx "app/(app)/dashboard/page.tsx" lib/transaction-presentation.ts tests/unit/recent-activity.test.tsx
git commit -m "Fold recent activity into presentTransaction"
```

---

## Finishing the stage

- [ ] **Full verification, fresh:**

```bash
npx vitest run && npx tsc --noEmit && npm run lint && npm run build && npm run check:invariants
```

Every one must pass before the branch is offered for review. Report the actual numbers, not "should pass".

- [ ] **Desktop diff check.** Load the dashboard at desktop width and confirm it is what it was: four tiles across at `lg`, exact figures with cents on all four, every account card showing, no "Show all" control. A visible change at desktop width is a Global Constraint violation, not a preference.

- [ ] **Ask the owner to check on their actual phone** via the PR's Vercel preview, and wait for the answer rather than merging on green CI. Name three specific things and no more:
  1. Net worth reads in full — `$1,182,885.15`, not clipped or wrapped.
  2. Cash / Spent / Saved sit on one row, rounded to whole dollars, nothing overlapping.
  3. Accounts show four with a "Show all 12" control that reveals the rest.

  Say plainly whether the preview has rebuilt since the last push. An earlier stage was re-tested against a stale build and the old behaviour was reported.

- [ ] **Anything found along the way that does not belong in this branch becomes an issue**, per `.claude/rules/filing-issues.md`. Do not widen this stage to fix it.
