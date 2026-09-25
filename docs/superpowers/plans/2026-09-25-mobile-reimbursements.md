# Mobile Reimbursements (Stage 3 of the Phone Pass) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the reimbursements page readable on a phone — both `<table>` layouts gain a card list below `md` — and retire the last duplicated copy of the merchant-name fallback.

**Architecture:** The page has two structurally identical tables (Date / Merchant / Note / Amount) that differ only in what the amount means. One `ReimbursementCard` serves both, taking an already-resolved label and amount so it makes no decisions of its own. Each table gets a `md:hidden` card-list sibling and is itself wrapped `hidden md:block`, the same dual-layout idiom stage 1 used on the transactions page. The merchant-name fallback both tables re-implement moves into `lib/transaction-presentation.ts` as an exported helper that `presentTransaction` itself uses.

**Tech Stack:** Next.js 16.3.5 (App Router, React 19.3.0 server components), Tailwind, Vitest + @testing-library/react, jsdom.

**Spec:** `docs/superpowers/specs/2026-09-22-mobile-pass-design.md` — §6 is this stage; §3.1 is the card shape it applies; §9 lists the stage's testing obligations.

## Global Constraints

- **Breakpoint is `md`.** Below `md` is the phone layout; `md` and up is today's desktop layout, unchanged. Stages 1-2 set this and stage 3 does not re-decide it.
- **Desktop output must not change.** Both tables keep their columns, their copy, their date format and their figures. The only permitted desktop edit is swapping the inline `merchant_name ?? name ?? 'Transaction'` expression for the shared helper, which returns the identical string.
- **No new interaction model.** §6: "No new interaction model is introduced here. If §3 is right, this page is an application of it." Cards are read-only, exactly as the table rows are today.
- **The two amounts must not be confused.** The outstanding table shows `r.remaining` (what is still owed); the covered table shows the full `reimbursable_amount` (what was reimbursed). The existing comment at the covered table's header exists because those two are "visually similar" and must "never be mistaken for each other". Cards inherit that obligation.
- **Verify before claiming done:** `npx vitest run`, `npx tsc --noEmit`, `npm run lint`, `npm run build`, `npm run check:invariants`.

## Rulings carried into this plan

Two places where §6 is ambiguous, decided here so no implementer has to guess:

1. **§6 says "the editor opens in the same style of sheet as §3.2 rather than inline." This stage adds no editor.** The page has none today — every row is read-only. That sentence constrains *how* an editor would open if one existed; it does not mandate adding one, and §6's own closing line rules out new interaction models. Adding an edit sheet here would be a feature, not a phone pass. *If this is wrong, the cost is that a follow-up adds the sheet.*

2. **§6 says rows expose "the amount, who owes it, and the outstanding balance", which reads like two figures. Cards show one, matching the table.** `UnreimbursedRow` carries only `remaining`, and the desktop table shows only that; the full marked amount is reachable via `byId` but is not displayed anywhere today. Showing a second figure would put information on the phone that desktop lacks — a divergence, not an application of §3. "Who owes it" is `reimbursable_note`, which is where a name like "Dave" is stored. *If this is wrong, the cost is that a partially-covered expense reads as though `remaining` were the whole charge.*

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `lib/transaction-presentation.ts` | Export `transactionLabel()`; `presentTransaction` consumes it | 1 |
| `components/ReimbursementCard.tsx` | **New.** One card: label + amount, then a muted `date · note` line | 2 |
| `app/(app)/reimbursements/page.tsx` | Card list below `md` for both tables; both merchant cells use the helper | 3 |

Tasks run in order: 3 consumes both 1 and 2.

---

### Task 1: One merchant-name fallback, exported

**Files:**
- Modify: `lib/transaction-presentation.ts`
- Test: `tests/unit/transaction-presentation.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `transactionLabel(t: { name: string | null; merchant_name: string | null }): string` — the merchant name, else the raw name, else `'Transaction'`.

**Why this is its own task:** `app/(app)/reimbursements/page.tsx` re-implements that expression twice (issue #106), and Task 3 rewrites both of those lines. Exporting the rule first means Task 3 consumes it rather than copying it a third time. `presentTransaction` must use the same function, or the two can drift — which is the whole failure this module exists to prevent.

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/transaction-presentation.test.ts`:

```ts
describe('transactionLabel', () => {
  // Plaid always sends `name`; `merchant_name` is the cleaner one when present. Every surface that
  // names a transaction has to agree, or the same row reads two ways on two screens.
  it('prefers the merchant name', () => {
    expect(transactionLabel({ name: 'JOE S DEN', merchant_name: 'Joe S Den' })).toBe('Joe S Den')
  })

  it('falls back to the raw name when there is no merchant', () => {
    expect(transactionLabel({ name: 'CAPITAL ONE AUTOPAY', merchant_name: null })).toBe(
      'CAPITAL ONE AUTOPAY'
    )
  })

  // Never empty. An empty label rendered into a merchant cell is indistinguishable from a bug.
  it('falls back to Transaction when neither is set', () => {
    expect(transactionLabel({ name: null, merchant_name: null })).toBe('Transaction')
  })

  // The seam that matters: presentTransaction must not keep its own copy of the rule.
  it('is the same answer presentTransaction gives', () => {
    const t = { ...base, name: 'JOE S DEN', merchant_name: null }
    expect(presentTransaction(t).label).toBe(transactionLabel(t))
  })
})
```

Add `transactionLabel` to the existing import at the top of the file.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run tests/unit/transaction-presentation.test.ts`
Expected: FAIL — `transactionLabel is not a function` / import error.

- [ ] **Step 3: Implement it**

In `lib/transaction-presentation.ts`, above `presentTransaction`:

```ts
// What to call a transaction on screen. Plaid always sends `name`, so the fallbacks are the
// belt-and-braces cases rather than the common one — but they are the cases where surfaces used to
// diverge, and `app/(app)/reimbursements/page.tsx` carried its own copy of this expression in two
// places (#106). Exported so that page can ask rather than re-derive.
export function transactionLabel(t: { name: string | null; merchant_name: string | null }): string {
  return t.merchant_name ?? t.name ?? 'Transaction'
}
```

Then, inside `presentTransaction`, replace these two lines:

```ts
  // Plaid always sends `name`, so the fallback is the belt-and-braces case rather than the common
  // one — but it is the case where the two surfaces used to diverge.
  const label = t.merchant_name ?? t.name ?? 'Transaction'
```

with:

```ts
  const label = transactionLabel(t)
```

…and carry that displaced comment into the new function, so the reasoning sits with the rule. The full comment block above `transactionLabel` therefore reads:

```ts
// What to call a transaction on screen. Plaid always sends `name`, so the fallbacks are the
// belt-and-braces case rather than the common one — but they are the case where surfaces used to
// diverge, and `app/(app)/reimbursements/page.tsx` carried its own copy of this expression in two
// places (#106). Exported so that page can ask rather than re-derive.
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run tests/unit/transaction-presentation.test.ts && npx vitest run`
Expected: both PASS. `presentTransaction`'s own label tests must still pass untouched — if any fails, the extraction changed behaviour and is wrong.

- [ ] **Step 5: Commit**

```bash
git add lib/transaction-presentation.ts tests/unit/transaction-presentation.test.ts
git commit -m "Export the merchant-name fallback so callers can ask instead of re-deriving"
```

---

### Task 2: `ReimbursementCard`

**Files:**
- Create: `components/ReimbursementCard.tsx`
- Test: `tests/unit/reimbursement-card.test.tsx` (new)

**Interfaces:**
- Consumes: `money`, `shortDate` from `@/lib/format`.
- Produces:

```ts
ReimbursementCard({
  label: string,       // already resolved by the caller via transactionLabel
  amount: number,      // already chosen by the caller: remaining, or the full marked figure
  date: string,        // 'YYYY-MM-DD'
  note?: string | null, // who owes it
})
```

**Why it takes resolved values:** the two lists disagree about what the amount *means* and the card must not have an opinion. A `variant` prop would push that decision into the component and make it possible to render the covered figure under the outstanding heading. The caller already knows which number it is holding.

The shape follows §3.1: name and amount on one line, a muted `date · note` line beneath.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/reimbursement-card.test.tsx`:

```tsx
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { ReimbursementCard } from '@/components/ReimbursementCard'

afterEach(cleanup)

const props = { label: 'Starbucks', amount: 8.2, date: '2026-09-01', note: 'Dave' }

describe('ReimbursementCard', () => {
  it('leads with the merchant and the amount', () => {
    render(<ReimbursementCard {...props} />)
    expect(screen.getByText('Starbucks')).toBeTruthy()
    expect(screen.getByText('$8.20')).toBeTruthy()
  })

  // §6: rows expose who owes it. The note is where a name lives.
  it('puts the date and who owes it on one muted line', () => {
    render(<ReimbursementCard {...props} />)
    expect(screen.getByText('Sep 1 · Dave')).toBeTruthy()
  })

  // A mark with no note is ordinary — most are. The separator must not strand itself.
  it('shows the date alone when there is no note', () => {
    render(<ReimbursementCard {...props} note={null} />)
    expect(screen.getByText('Sep 1')).toBeTruthy()
    expect(screen.queryByText(/·/)).toBeNull()
  })

  it('treats an empty note the same as no note', () => {
    render(<ReimbursementCard {...props} note="" />)
    expect(screen.queryByText(/·/)).toBeNull()
  })

  // The figure is the reason the page exists; it must not be the thing that wraps.
  it('keeps the amount on one line', () => {
    render(<ReimbursementCard {...props} amount={12345.67} />)
    expect(screen.getByText('$12,345.67').className).toContain('whitespace-nowrap')
  })

  it('renders a long merchant name without pushing the amount off', () => {
    render(<ReimbursementCard {...props} label={'A'.repeat(60)} />)
    expect(screen.getByText('A'.repeat(60)).className).toContain('truncate')
  })
})
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run tests/unit/reimbursement-card.test.tsx`
Expected: FAIL — `components/ReimbursementCard` does not exist.

- [ ] **Step 3: Write the component**

Create `components/ReimbursementCard.tsx`:

```tsx
import { money, shortDate } from '@/lib/format'

// One marked expense, below `md`, where the four-column table has nowhere to put itself. Same shape
// as the transactions card (spec §3.1): what it was and how much on the first line, the quieter
// facts on a second.
//
// Takes a RESOLVED label and a RESOLVED amount. The outstanding list passes what is still owed and
// the covered list passes the full reimbursed figure — two different quantities that the desktop
// table is careful to label differently. Giving this component a `variant` instead would move that
// choice in here, where it would be possible to render one list's figure under the other's heading.
export function ReimbursementCard({
  label,
  amount,
  date,
  note,
}: {
  label: string
  amount: number
  date: string
  note?: string | null
}) {
  // An empty string is as good as absent: a note nobody filled in must not leave a dangling '·'.
  const who = note?.trim() ? note.trim() : null
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-line px-4 py-3 last:border-b-0">
      <div className="min-w-0">
        <div className="truncate font-medium text-ink">{label}</div>
        <div className="truncate text-xs text-muted">{who ? `${shortDate(date)} · ${who}` : shortDate(date)}</div>
      </div>
      <div className="shrink-0 whitespace-nowrap font-medium tabular-nums text-ink">{money(amount)}</div>
    </div>
  )
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run tests/unit/reimbursement-card.test.tsx`
Expected: PASS, all six.

- [ ] **Step 5: Check the tests bite**

jsdom computes no layout, so class strings are the only evidence a layout choice holds — stages 2 and 3 of this pass each needed a follow-up round after mutations proved otherwise. Mutate and confirm each is caught, restoring after every one:

- drop `truncate` from the label → the long-name test must fail
- drop `whitespace-nowrap` from the amount → the one-line test must fail
- change `who` to `note ?? null` (so an empty string renders) → the empty-note test must fail

If any mutation survives, strengthen the test until it fails, then restore. Record all three results.

- [ ] **Step 6: Commit**

```bash
git add components/ReimbursementCard.tsx tests/unit/reimbursement-card.test.tsx
git commit -m "Add the phone presentation of a reimbursable expense"
```

---

### Task 3: Both tables gain a card list

**Files:**
- Modify: `app/(app)/reimbursements/page.tsx`
- Test: `tests/unit/reimbursements-page.test.tsx` (new)

**Interfaces:**
- Consumes: `transactionLabel` (Task 1), `ReimbursementCard` (Task 2).
- Produces: no new exports.

**Locate edits by content, not line number** — Tasks 1 and 2 do not touch this file, but the plan's line references are from before any of this work.

**The two places to change, both the same shape:** each `<table>` is wrapped so it only renders from `md` up, and gains a card-list sibling that only renders below it. The outstanding table sits directly inside `<Card className="p-0">`; the covered table sits inside a `<Card>` under a month heading.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/reimbursements-page.test.tsx`. This mirrors `tests/unit/dashboard-page.test.tsx` — the page is an async server component, so the test calls it directly and walks the returned element tree rather than mounting it:

```tsx
import { describe, it, expect, beforeEach, vi } from 'vitest'

const { results } = vi.hoisted(() => ({
  results: {} as Record<string, { data: unknown; error: { message: string } | null }>,
}))

const chainFor = (table: string) => {
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'order', 'eq', 'not', 'gte', 'lte', 'limit']) chain[m] = () => chain
  chain.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(results[table] ?? { data: [], error: null }).then(resolve)
  return chain
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ from: (table: string) => chainFor(table) }),
}))

import ReimbursementsPage from '@/app/(app)/reimbursements/page'

const render = () => ReimbursementsPage()

// Collect every className in the returned tree. jsdom computes no layout, so the class strings are
// the only evidence the two layouts are gated on the breakpoint at all.
function classNamesOf(node: unknown): string[] {
  const out: string[] = []
  const walk = (n: unknown) => {
    if (n == null || typeof n !== 'object') return
    if (Array.isArray(n)) {
      n.forEach(walk)
      return
    }
    const el = n as { props?: { className?: unknown; children?: unknown } }
    if (typeof el.props?.className === 'string') out.push(el.props.className)
    if (el.props?.children) walk(el.props.children)
  }
  walk(node)
  return out
}

// Collect the ReimbursementCard elements so assertions can read their props directly.
type CardProps = { label: string; amount: number; date: string; note?: string | null }
function cardsOf(node: unknown): { props: CardProps }[] {
  const found: { props: CardProps }[] = []
  const walk = (n: unknown) => {
    if (n == null || typeof n !== 'object') return
    if (Array.isArray(n)) {
      n.forEach(walk)
      return
    }
    const el = n as { type?: unknown; props?: { children?: unknown } }
    if (typeof el.type === 'function' && (el.type as { name?: string }).name === 'ReimbursementCard') {
      found.push(el as unknown as { props: CardProps })
    }
    if (el.props?.children) walk(el.props.children)
  }
  walk(node)
  return found
}

// One $100 expense, half covered by a $50 deposit: `remaining` is 50 while the marked amount is 100.
// That gap is exactly what the outstanding card must not get wrong.
beforeEach(() => {
  results.transactions = {
    data: [
      {
        id: 'e1',
        amount: 100,
        date: '2026-09-01',
        name: 'STARBUCKS STORE 123',
        merchant_name: 'Starbucks',
        reimbursable_amount: 100,
        reimbursable_note: 'Dave',
      },
      {
        id: 'd1',
        amount: -50,
        date: '2026-09-05',
        name: 'ACME EXPENSES',
        merchant_name: null,
        reimbursable_amount: 50,
        reimbursable_note: null,
      },
    ],
    error: null,
  }
})

describe('Reimbursements page', () => {
  // #46's lesson, already enforced for the read: a failed query must not render as "nothing owed".
  it('fails loudly when the read fails, rather than reporting nothing outstanding', async () => {
    results.transactions = { data: null, error: { message: 'connection reset' } }
    await expect(render()).rejects.toThrow(/could not read reimbursable transactions/)
  })

  it('offers a card for the outstanding expense', async () => {
    const cards = cardsOf(await render())
    expect(cards.length).toBeGreaterThan(0)
    expect(cards[0].props.label).toBe('Starbucks')
  })

  // The card shows what is STILL OWED, not the full marked figure. The desktop table labels those
  // two columns differently on purpose; a card has no header to disambiguate them.
  it('shows the outstanding remainder on the card, not the whole marked amount', async () => {
    const card = cardsOf(await render())[0]
    expect(card.props.amount).toBe(50)
    expect(card.props.amount).not.toBe(100)
  })

  it('passes who owes it through to the card', async () => {
    expect(cardsOf(await render())[0].props.note).toBe('Dave')
  })

  // Both layouts ship; CSS picks. Reverting either wrapper is the mutation this catches.
  it('gates the table and the card list on the breakpoint', async () => {
    const classes = classNamesOf(await render())
    expect(classes).toContain('md:hidden')
    expect(classes.some((c) => c.includes('hidden') && c.includes('md:block'))).toBe(true)
  })
})
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run tests/unit/reimbursements-page.test.tsx`
Expected: FAIL — no `ReimbursementCard` in the tree, and neither breakpoint class present.

- [ ] **Step 3: Wire the outstanding list**

In `app/(app)/reimbursements/page.tsx`, find `<Card className="p-0">` holding the first `<table>`. Wrap that table and add the card list before it:

```tsx
        <Card className="p-0">
          {/* Below `md` the four columns have nowhere to go, so the same rows render as cards —
              the treatment stage 1 applied to transactions (spec §3.1, §6). The figure here is
              what is STILL OWED, which is the column this table calls "Outstanding". */}
          <div className="md:hidden">
            {outstanding.map((r) => {
              const t = byId.get(r.id)
              return (
                <ReimbursementCard
                  key={r.id}
                  label={transactionLabel({ name: t?.name ?? null, merchant_name: t?.merchant_name ?? null })}
                  amount={r.remaining}
                  date={r.date}
                  note={t?.reimbursable_note}
                />
              )
            })}
          </div>
          <div className="hidden md:block">
            <table className="w-full text-sm">
```

…and close that new `<div>` after the table's `</table>`.

Replace the table's own merchant cell expression with the helper:

```tsx
                    <td className="truncate px-4 py-3 font-medium text-ink">
                      {transactionLabel({ name: t?.name ?? null, merchant_name: t?.merchant_name ?? null })}
                    </td>
```

- [ ] **Step 4: Wire the covered list**

Same shape inside the month `<Card>`, after the month heading `<div>`:

```tsx
              {/* The FULL reimbursed figure here, not a remainder — these are settled. Same
                  distinction the table's "Reimbursed" header draws. */}
              <div className="md:hidden">
                {coveredByMonth.get(key)!.map((t) => (
                  <ReimbursementCard
                    key={t.id}
                    label={transactionLabel(t)}
                    amount={Number(t.reimbursable_amount)}
                    date={t.date}
                    note={t.reimbursable_note}
                  />
                ))}
              </div>
              <div className="hidden md:block">
                <table className="w-full text-sm">
```

…closing the new `<div>` after that table's `</table>`, and replacing its merchant cell with `{transactionLabel(t)}`.

Add the imports:

```tsx
import { ReimbursementCard } from '@/components/ReimbursementCard'
import { transactionLabel } from '@/lib/transaction-presentation'
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `npx vitest run tests/unit/reimbursements-page.test.tsx && npx vitest run && npx tsc --noEmit && npm run lint`
Expected: all clean.

- [ ] **Step 6: Check the tests bite**

Mutate and confirm each is caught, restoring after every one:

- remove `md:hidden` from the outstanding card list → the breakpoint test must fail
- remove `hidden md:block` from either table wrapper → the breakpoint test must fail
- pass `amount={Number(t?.reimbursable_amount)}` instead of `r.remaining` on the outstanding card → the remainder test must fail

Record all three results.

- [ ] **Step 7: Commit**

```bash
git add "app/(app)/reimbursements/page.tsx" tests/unit/reimbursements-page.test.tsx
git commit -m "Render reimbursable expenses as cards below md"
```

---

## Finishing the stage

- [ ] **Full verification, fresh:**

```bash
npx vitest run && npx tsc --noEmit && npm run lint && npm run build && npm run check:invariants
```

Report the actual numbers, not "should pass".

- [ ] **Confirm #106 is closed by this branch.** `grep -rn "merchant_name ??" app/ components/` must return nothing outside `lib/transaction-presentation.ts`. If it does, name what is left.

- [ ] **Desktop diff check.** Load `/reimbursements` at desktop width: both tables unchanged — same columns, same headers, same raw `YYYY-MM-DD` date format, same figures. A visible difference at desktop width is a Global Constraint violation.

- [ ] **Ask the owner to check on their actual phone** via the PR's Vercel preview, and name three things and no more:
  1. Outstanding expenses read as cards — merchant, amount, and a `date · who owes it` line beneath.
  2. A partially-covered expense shows what is still owed, not the original charge.
  3. "Already reimbursed" months read the same way, with the full reimbursed figure.

  Say plainly whether the preview has rebuilt since the last push.

- [ ] **Anything found that does not belong in this branch becomes an issue**, per `.claude/rules/filing-issues.md`.
