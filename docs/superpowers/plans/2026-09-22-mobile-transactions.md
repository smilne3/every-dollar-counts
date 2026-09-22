# Mobile Transactions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Below `md`, the transactions table becomes a tappable card list whose controls live in a sheet, so nothing overlaps and every control is reachable with a thumb.

**Architecture:** One pure module (`lib/transaction-presentation.ts`) owns what a transaction *means* — its label, its display sign, its colour tone, whether it is a card payment, and its reimbursable share. Both the existing desktop `<tr>` and the new phone card read from it, so the two presentations cannot drift in meaning even though their markup differs. The sheet is the existing `Dialog` hosting the existing `CategoryPicker`, `ReimbursableCheckbox` and `ReimbursableEditor` — no phone-specific variant of any control is written.

**Tech Stack:** Next.js 16 App Router, React 19, Tailwind v4, Vitest 4 + @testing-library/react, jsdom.

**Spec:** `docs/superpowers/specs/2026-09-22-mobile-pass-design.md` (this plan implements §3 and stage 1 of §8 only)

## Global Constraints

- **`md` is the only breakpoint.** Phone layout below it, existing layout at and above it. `AppShell` already switches at `md`; a second boundary would put content out of step with the chrome.
- **The desktop table is not restyled.** Its markup may be *wrapped*, never edited. The one edit permitted to `TransactionRow.tsx` is swapping its inline derivations for `presentTransaction` — output must be identical.
- **The card-payment exemption is a correctness constraint, not a style choice.** Where `isCreditCardPayment` is true, no category picker, no reimbursable checkbox and no editor may be rendered — on either layout. Setting `user_category` on a card payment re-enters both legs into the totals; on a real $7,866.69 payment that is the difference between September spending of $3,949.16 and **minus** $3,917.53 (`TransactionRow.tsx:48-58`).
- **No file under `lib/` that computes money is edited.** Not `dashboard.ts`, `budget.ts`, `reimbursements.ts`, `spend-context.ts`, `categories.ts`. `lib/transaction-presentation.ts` is new and presentational only.
- **Sign convention is `display = -amount`.** Plaid positive means money out. This rule exists once, in `presentTransaction`, and nowhere else after Task 1.
- **Run the whole suite, not one file, before each commit.** Baseline is 338 passing tests.

---

## File Structure

| File | Responsibility |
|---|---|
| `lib/transaction-presentation.ts` | **Create.** Pure: transaction → `{label, display, tone, isCC, shareAmount}`. The single source of meaning for both layouts. |
| `tests/unit/transaction-presentation.test.ts` | **Create.** Covers the sign rule, the tone rule, the card-payment override and share signing. |
| `components/TransactionRow.tsx` | **Modify.** Replaces its five inline derivations with one `presentTransaction` call. No visual change. |
| `components/TransactionCard.tsx` | **Create.** The phone row plus its sheet. Client component. |
| `tests/unit/transaction-card.test.tsx` | **Create.** Covers the meta line, the share line, parity with the desktop row, and the card-payment exemption in the sheet. |
| `app/(app)/transactions/page.tsx` | **Modify.** Wraps the table in `hidden md:block`; adds the `md:hidden` card list beside it. |

---

## Task 1: One source of meaning

Extracts what a transaction means from `TransactionRow` so a second presentation can consume it. Nothing visual changes in this task — the existing `transaction-row.test.tsx` passing unchanged afterwards is the proof.

**Files:**
- Create: `lib/transaction-presentation.ts`
- Create: `tests/unit/transaction-presentation.test.ts`
- Modify: `components/TransactionRow.tsx:32-37` (the inline derivations) and `:68-70` (the tone ternary)

**Interfaces:**
- Consumes: `isCreditCardPayment` from `@/lib/categories` (existing).
- Produces: `presentTransaction(t: PresentableTxn): PresentedTxn` and `TONE_CLASS: Record<'out'|'in'|'neutral', string>`. Tasks 2 and 3 use both.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/transaction-presentation.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { presentTransaction } from '@/lib/transaction-presentation'

const base = {
  amount: 100,
  name: 'JOE S DEN',
  merchant_name: 'Joe S Den' as string | null,
  user_category: null as string | null,
  pfc_detailed: null as string | null,
  reimbursable_amount: null as number | null,
}

describe('presentTransaction', () => {
  // Plaid: positive means money OUT. Every surface shows that as negative.
  it('flips Plaid sign for display', () => {
    expect(presentTransaction(base).display).toBe(-100)
    expect(presentTransaction({ ...base, amount: -250 }).display).toBe(250)
  })

  it('tones an outflow as ink and an inflow as emerald', () => {
    expect(presentTransaction(base).tone).toBe('out')
    expect(presentTransaction({ ...base, amount: -250 }).tone).toBe('in')
  })

  // The $7,866.69 case: money INTO the card is an inflow by sign, but it is your own
  // money moving between your own accounts and must never read as income.
  it('tones a credit-card payment neutral whichever way it points', () => {
    const cc = { ...base, pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' }
    expect(presentTransaction({ ...cc, amount: -7866.69 }).tone).toBe('neutral')
    expect(presentTransaction({ ...cc, amount: 7866.69 }).tone).toBe('neutral')
    expect(presentTransaction({ ...cc, amount: -7866.69 }).isCC).toBe(true)
  })

  // A user override deliberately wins, which is what re-enters both legs into the totals.
  it('stops treating it as a card payment once the user overrides the category', () => {
    const p = presentTransaction({
      ...base,
      pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT',
      user_category: 'Shopping',
    })
    expect(p.isCC).toBe(false)
  })

  it('prefers the merchant name and falls back to the raw name', () => {
    expect(presentTransaction(base).label).toBe('Joe S Den')
    expect(presentTransaction({ ...base, merchant_name: null }).label).toBe('JOE S DEN')
  })

  it('reports no share when nothing is marked', () => {
    expect(presentTransaction(base).shareAmount).toBeNull()
  })

  // An outflow's share is money out (negative); an inflow's remainder is money in.
  it('signs the share to match the display convention', () => {
    expect(presentTransaction({ ...base, amount: 100, reimbursable_amount: 40 }).shareAmount).toBe(-60)
    expect(presentTransaction({ ...base, amount: -100, reimbursable_amount: 40 }).shareAmount).toBe(60)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/unit/transaction-presentation.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/transaction-presentation"`.

- [ ] **Step 3: Write the module**

Create `lib/transaction-presentation.ts`:

```ts
import { isCreditCardPayment } from './categories'

// What a transaction MEANS, separate from how any one surface draws it. The desktop <tr> and the
// phone card have different markup and must not have different meaning: the sign convention, the
// colour rule and the card-payment exemption live here once, so a change reaches both or neither.
export type PresentableTxn = {
  amount: number
  name: string | null
  merchant_name: string | null
  user_category: string | null
  pfc_detailed: string | null
  reimbursable_amount: number | null
}

export type PresentedTxn = {
  label: string | null
  display: number
  tone: 'out' | 'in' | 'neutral'
  isCC: boolean
  // Signed like `display`, or null when the transaction carries no mark.
  shareAmount: number | null
}

export function presentTransaction(t: PresentableTxn): PresentedTxn {
  // Plaid: amount > 0 means money OUT. Show spending as negative.
  const display = -t.amount
  const marked = Number(t.reimbursable_amount ?? 0)
  const isCC = isCreditCardPayment({ pfc_detailed: t.pfc_detailed, user_category: t.user_category })
  const share = Math.max(0, Math.abs(t.amount) - marked)
  return {
    label: t.merchant_name ?? t.name,
    display,
    // A card payment is neither spending nor income — both legs are already excluded from every
    // total. Painting the crediting leg emerald made $7,866.69 read as income (#31).
    tone: isCC ? 'neutral' : display < 0 ? 'out' : 'in',
    isCC,
    shareAmount: marked > 0 ? (t.amount < 0 ? share : -share) : null,
  }
}

export const TONE_CLASS: Record<PresentedTxn['tone'], string> = {
  out: 'text-ink',
  in: 'text-emerald',
  neutral: 'text-muted',
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run tests/unit/transaction-presentation.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Make `TransactionRow` consume it**

In `components/TransactionRow.tsx`, add to the imports:

```tsx
import { presentTransaction, TONE_CLASS } from '@/lib/transaction-presentation'
```

Replace the five derivations in the component body (`const display` through `const isCC`) with:

```tsx
  const { label, display, tone, isCC, shareAmount } = presentTransaction(t)
  const marked = Number(t.reimbursable_amount ?? 0)
```

Replace the amount cell's className expression with:

```tsx
        className={`px-4 py-3 text-right font-medium tabular-nums ${TONE_CLASS[tone]}`}
```

Replace the share expression inside the reserved span with:

```tsx
          {isCC ? 'between accounts' : shareAmount !== null ? `your share ${money(shareAmount)}` : ' '}
```

Leave `isCreditCardPayment` imported only if still referenced; if not, remove the import so lint stays clean.

- [ ] **Step 6: Prove nothing changed**

Run: `npx vitest run && npx tsc --noEmit && npm run lint`
Expected: 345 tests pass (338 + 7), tsc exit 0, lint exit 0. **The nine existing `transaction-row.test.tsx` assertions passing untouched is the evidence this refactor was behaviour-preserving.**

- [ ] **Step 7: Commit**

```bash
git add lib/transaction-presentation.ts tests/unit/transaction-presentation.test.ts components/TransactionRow.tsx
git commit -m "Give both transaction layouts one source of meaning

The phone layout needs the same sign rule, colour rule and card-payment
exemption the table already has. Extracted rather than copied, so the two
presentations cannot drift: markup may differ, meaning may not.

No visual change — the existing row tests pass untouched."
```

---

## Task 2: The phone card, without its sheet

A tappable row that shows merchant, amount and a meta line. The sheet arrives in Task 3; this task ends with a card that renders correctly and does nothing when tapped.

**Files:**
- Create: `components/TransactionCard.tsx`
- Create: `tests/unit/transaction-card.test.tsx`

**Interfaces:**
- Consumes: `presentTransaction`, `TONE_CLASS` (Task 1); `money` from `@/lib/format`.
- Produces: `<TransactionCard t={Txn} categoryName={string} categoryOptions={string[]} />` — the same three props `TransactionRow` takes, so Task 4 can map over one list with either.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/transaction-card.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { TransactionCard } from '@/components/TransactionCard'
import { TransactionRow } from '@/components/TransactionRow'

afterEach(cleanup)
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }))

const txn = {
  id: 't1',
  date: '2026-08-29',
  name: 'JOE S DEN',
  merchant_name: 'Joe S Den' as string | null,
  amount: 100,
  user_category: null as string | null,
  pfc_detailed: null as string | null,
  reimbursable_amount: null as number | null,
  reimbursable_note: null as string | null,
}

function renderCard(overrides: Partial<typeof txn> = {}) {
  return render(
    <TransactionCard t={{ ...txn, ...overrides }} categoryName="Food" categoryOptions={['Food', 'Grocery']} />
  )
}

describe('TransactionCard', () => {
  it('shows the merchant and the display amount', () => {
    renderCard()
    expect(screen.getByText('Joe S Den')).toBeTruthy()
    expect(screen.getByText('-$100.00')).toBeTruthy()
  })

  it('puts date and category on one muted meta line', () => {
    renderCard()
    expect(screen.getByText(/2026-08-29 · Food/)).toBeTruthy()
  })

  // Without this the mark is invisible until the row is opened, which makes "what have I already
  // marked?" answerable only by tapping every row in turn (spec §3.1).
  it('shows the share on the meta line once marked', () => {
    renderCard({ reimbursable_amount: 40 })
    expect(screen.getByText(/your share -\$60\.00/)).toBeTruthy()
  })

  it('omits the share line when nothing is marked', () => {
    renderCard()
    expect(screen.queryByText(/your share/)).toBeNull()
  })

  it('opens a sheet when tapped', () => {
    renderCard()
    expect(screen.getByRole('button', { name: /Joe S Den/ })).toBeTruthy()
  })
})

// The containment promised by spec §9: two presentations, one meaning.
describe('phone card and desktop row agree', () => {
  const cases = [
    { name: 'ordinary outflow', o: {} },
    { name: 'income inflow', o: { amount: -2772.63, pfc_detailed: 'INCOME_WAGES' } },
    { name: 'credit-card payment', o: { amount: -7866.69, pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' } },
  ]
  for (const c of cases) {
    it(`render the same amount text for a ${c.name}`, () => {
      const { container: cardEl } = render(
        <TransactionCard t={{ ...txn, ...c.o }} categoryName="Food" categoryOptions={['Food']} />
      )
      const cardText = cardEl.textContent ?? ''
      cleanup()
      const { container: rowEl } = render(
        <table><tbody>
          <TransactionRow t={{ ...txn, ...c.o }} categoryName="Food" categoryOptions={['Food']} />
        </tbody></table>
      )
      const rowText = rowEl.textContent ?? ''
      const amount = rowText.match(/-?\$[\d,]+\.\d{2}/)?.[0]
      expect(amount).toBeDefined()
      expect(cardText).toContain(amount as string)
    })
  }
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/unit/transaction-card.test.tsx`
Expected: FAIL — `Failed to resolve import "@/components/TransactionCard"`.

- [ ] **Step 3: Write the component**

Create `components/TransactionCard.tsx`:

```tsx
'use client'

import { useState } from 'react'
import { money } from '@/lib/format'
import { presentTransaction, TONE_CLASS } from '@/lib/transaction-presentation'

type Txn = {
  id: string
  date: string
  name: string | null
  merchant_name: string | null
  amount: number
  user_category: string | null
  pfc_detailed: string | null
  reimbursable_amount: number | null
  reimbursable_note: string | null
}

// The phone presentation of one transaction. Takes the same three props as TransactionRow so the
// page can map one list with either, and derives every displayed value from presentTransaction so
// the two cannot disagree about what the transaction is.
export function TransactionCard({
  t,
  categoryName,
  categoryOptions,
}: {
  t: Txn
  categoryName: string
  categoryOptions: string[]
}) {
  const [open, setOpen] = useState(false)
  const { label, display, tone, isCC, shareAmount } = presentTransaction(t)
  const name = label ?? 'Transaction'

  // The whole row is the control: a 390px row has no room for a separate affordance, and the
  // sheet is the only place the category and reimbursable controls fit (spec §3.2).
  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      aria-label={`${name}, ${money(display)} — edit`}
      className="flex w-full items-start justify-between gap-3 border-b border-line px-4 py-3 text-left transition-colors last:border-b-0 active:bg-surface-2"
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-ink">{name}</span>
        <span className="mt-0.5 block truncate text-xs text-muted">
          {t.date} · {isCC ? 'Card payment' : categoryName}
          {shareAmount !== null && ` · your share ${money(shareAmount)}`}
        </span>
      </span>
      <span className={`shrink-0 font-medium tabular-nums ${TONE_CLASS[tone]}`}>{money(display)}</span>
    </button>
  )
}
```

Note: `categoryOptions` is unused until Task 3. Prefix it in the destructure if lint objects: keep the prop in the type and read it in Task 3.

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run tests/unit/transaction-card.test.tsx`
Expected: PASS, 8 tests.

- [ ] **Step 5: Run everything**

Run: `npx vitest run && npx tsc --noEmit && npm run lint`
Expected: 353 tests pass, tsc exit 0, lint exit 0.

- [ ] **Step 6: Commit**

```bash
git add components/TransactionCard.tsx tests/unit/transaction-card.test.tsx
git commit -m "Add the phone presentation of a transaction

Merchant, amount and a date · category meta line, with the reimbursable share
shown inline so marked rows are identifiable without opening each one.

Takes the same props as TransactionRow and derives every value from
presentTransaction, with a test asserting both render the same amount for an
outflow, an inflow and a card payment."
```

---

## Task 3: The sheet

Gives the three existing controls somewhere to live. No new control is written.

**Files:**
- Modify: `components/TransactionCard.tsx`
- Modify: `tests/unit/transaction-card.test.tsx` (append the sheet describe block)

**Interfaces:**
- Consumes: `Dialog` from `@/components/ui/Dialog`; `CategoryPicker`, `ReimbursableCheckbox`, `ReimbursableEditor`; `Button` from `@/components/ui/Button`.
- Produces: nothing new. Task 4 depends only on the Task 2 signature.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/transaction-card.test.tsx`:

```tsx
import { fireEvent } from '@testing-library/react'
import { beforeAll } from 'vitest'

// jsdom does not implement showModal()/close() on <dialog>, so Dialog's open effect cannot run
// without these. Copied verbatim from tests/unit/confirm-dialog.test.tsx:11-18, which needs them
// for the same reason. Real modal behaviour — focus trap, Escape, backdrop — is the platform's
// job and is verified in the browser (Task 4, Step 5), not here.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function () {
    this.open = false
  }
})

describe('TransactionCard sheet', () => {
  function openSheet(overrides: Partial<typeof txn> = {}) {
    render(
      <TransactionCard t={{ ...txn, ...overrides }} categoryName="Food" categoryOptions={['Food', 'Grocery']} />
    )
    fireEvent.click(screen.getByRole('button', { name: /edit/ }))
  }

  it('offers the category picker on an ordinary charge', () => {
    openSheet()
    expect(screen.getByRole('combobox')).toBeTruthy()
  })

  // The constraint this whole plan is most at risk of breaking. Setting user_category on a card
  // payment re-enters both legs into the totals: on a real $7,866.69 payment that is September
  // spending of $3,949.16 versus MINUS $3,917.53.
  it('offers no picker, checkbox or editor on a credit-card payment', () => {
    openSheet({ pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', amount: -7866.69 })
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.queryByRole('button', { name: /partial reimbursable amount/ })).toBeNull()
  })

  it('explains what a card payment is instead of offering controls', () => {
    openSheet({ pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', amount: -7866.69 })
    expect(screen.getByText(/moves between your accounts/)).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/unit/transaction-card.test.tsx`
Expected: FAIL — no combobox found; clicking the row renders no dialog.

- [ ] **Step 3: Add the sheet**

In `components/TransactionCard.tsx`, add imports:

```tsx
import { Dialog } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { CategoryPicker } from '@/components/CategoryPicker'
import { ReimbursableCheckbox } from '@/components/ReimbursableCheckbox'
import { ReimbursableEditor } from '@/components/ReimbursableEditor'
```

Wrap the returned `<button>` in a fragment and add the dialog after it:

```tsx
  return (
    <>
      {/* the <button> from Task 2, unchanged */}

      <Dialog
        open={open}
        title={name}
        onCancel={() => setOpen(false)}
        footer={<Button variant="secondary" onClick={() => setOpen(false)}>Done</Button>}
      >
        <p className={`mt-1 text-sm tabular-nums ${TONE_CLASS[tone]}`}>
          {t.date} · {money(display)}
        </p>

        {isCC ? (
          // Same exemption the desktop row enforces. A user_category here re-enters both legs of
          // the payment into every total — see TransactionRow.tsx:48-58.
          <p className="mt-4 text-sm text-muted">Card payment — moves between your accounts.</p>
        ) : (
          <div className="mt-4 flex flex-col gap-4">
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-semibold uppercase tracking-wide text-faint">Category</span>
              <CategoryPicker
                transactionId={t.id}
                value={categoryName}
                options={categoryOptions}
                label={name}
              />
            </label>

            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wide text-faint">Reimbursable</span>
              <ReimbursableCheckbox
                transactionId={t.id}
                amount={t.amount}
                reimbursableAmount={t.reimbursable_amount}
                note={t.reimbursable_note}
                label={name}
                pfcDetailed={t.pfc_detailed}
                userCategory={t.user_category}
              />
            </div>

            <ReimbursableEditor
              transactionId={t.id}
              amount={t.amount}
              reimbursableAmount={t.reimbursable_amount}
              note={t.reimbursable_note}
              label={name}
              date={t.date}
            />
          </div>
        )}
      </Dialog>
    </>
  )
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run tests/unit/transaction-card.test.tsx`
Expected: PASS, 11 tests.

If the dialog's contents are still not found, the `beforeAll` polyfill from Step 1 is missing or was placed after the `describe`. It must run before any render. Do not change `Dialog` to accommodate the test environment.

- [ ] **Step 5: Run everything**

Run: `npx vitest run && npx tsc --noEmit && npm run lint`
Expected: 356 tests pass, tsc exit 0, lint exit 0.

- [ ] **Step 6: Commit**

```bash
git add components/TransactionCard.tsx tests/unit/transaction-card.test.tsx
git commit -m "Give the phone row's controls a sheet to live in

A 390px row has nowhere to put a category select, a checkbox, an editor
trigger and an amount at once. The sheet is the existing Dialog hosting the
three existing controls unchanged — no phone variant of any of them.

Honours the card-payment exemption the desktop row already enforces, with a
test, because a user_category there re-enters both legs into every total."
```

---

## Task 4: Wire it into the page

**Files:**
- Modify: `app/(app)/transactions/page.tsx:211-257` (the `<Card>` holding the table)

**Interfaces:**
- Consumes: `<TransactionCard>` (Task 2 signature).
- Produces: nothing.

- [ ] **Step 1: Add the import**

In `app/(app)/transactions/page.tsx`, beside the existing `TransactionRow` import:

```tsx
import { TransactionCard } from '@/components/TransactionCard'
```

- [ ] **Step 2: Wrap the table and add the list**

Replace the opening of the table's `<Card>` — currently:

```tsx
        <Card className="overflow-hidden p-0">
          <div className="overflow-x-auto">
```

with:

```tsx
        <Card className="overflow-hidden p-0">
          {/* Phone: the six-column table needs ~800px and gets 390, where `w-full table-fixed`
              stops overflow-x-auto engaging and the amount is painted over the category pill.
              Below md the same rows render as cards instead. */}
          <div className="md:hidden">
            {list.map((t) => (
              <TransactionCard
                key={t.id}
                t={t}
                categoryName={effectiveCategory(t, pfcMap)}
                categoryOptions={categoryOptions}
              />
            ))}
          </div>
          <div className="hidden overflow-x-auto md:block">
```

The table, its `colgroup`, `thead` and `tbody` are **not otherwise edited**. The closing `</div>` of the old `overflow-x-auto` wrapper now closes the `hidden … md:block` one.

- [ ] **Step 3: Verify both layouts compile and the page still builds**

Run: `npx tsc --noEmit && npm run build`
Expected: tsc exit 0; build exit 0 with `/transactions` still listed as a route.

- [ ] **Step 4: Run everything**

Run: `npx vitest run && npm run lint && npm run check:invariants`
Expected: 356 tests pass, lint exit 0, `invariants ok`.

- [ ] **Step 5: Look at it — the step the tests cannot do**

jsdom computes no layout, so no assertion above proves the overlap is gone.

```bash
npm run dev
```

On a real phone (or DevTools at 390px), open `/transactions` and confirm:
1. No text overlaps any other text.
2. Tapping a row opens the sheet; the category wheel is usable with a thumb.
3. A credit-card payment row — search `AUTOPAY PAYMENT` — opens a sheet with **no** controls.
4. A row with a reimbursable mark shows `your share …` without being opened.
5. At desktop width the table is exactly as it was.

- [ ] **Step 6: Commit**

```bash
git add "app/(app)/transactions/page.tsx"
git commit -m "Render transactions as cards below md

The table declares ~800px of fixed columns. At 390px w-full table-fixed stops
overflow-x-auto engaging, so columns compress and the nowrap amount paints over
the category pill instead of scrolling.

Below md the same rows render as cards; at md and above the table is unchanged.
Both map the same list through the same effectiveCategory call."
```

---

## Self-Review

**Spec coverage (§3 and §8 stage 1):**

| Spec requirement | Task |
|---|---|
| §3.1 card list: merchant, amount, `date · category` | Task 2, Steps 1–3 |
| §3.1 reimbursable mark visible without opening | Task 2, Step 1 test 3 |
| §3.1 sign and colour conventions preserved | Task 1 |
| §3.2 sheet hosting the three existing controls | Task 3, Step 3 |
| §3.2 card-payment exemption honoured in the sheet | Task 3, Step 1 test 2 |
| §2 desktop untouched | Task 4, Step 2 — table wrapped, not edited; verified Step 5.5 |
| §9 both presentations derive one meaning | Task 1 + Task 2 parity test |
| §9 sheet honours the exemption | Task 3 |

§4–§7 belong to stages 2–5 and get their own plans. §5.1's palette change is stage 4.

**Placeholder scan:** no TBD/TODO. Every code step carries the code. Task 3's jsdom `<dialog>` note gives a specific remedy rather than "handle issues".

**Type consistency:** `presentTransaction` returns `{label, display, tone, isCC, shareAmount}` in Task 1 and every later use destructures exactly those five. `TONE_CLASS` is keyed by the same three tone values it is typed with. `TransactionCard`'s three props match `TransactionRow`'s, which is what lets Task 4 map one list with either. `shareAmount` is `number | null` throughout and is always compared with `!== null`, never truthiness — `0` would otherwise be dropped.

**Two gaps found and closed during review:**

1. Task 2's component read `categoryOptions` nowhere, which would fail lint before Task 3 used it. Step 3 now says so explicitly rather than leaving the implementer to discover it.
2. Task 3 originally said "if the contents are not found, consider a polyfill" — a conditional dressed as a step. Verified against the codebase: jsdom does **not** implement `showModal`, `tests/unit/confirm-dialog.test.tsx:11-18` already carries the polyfill for exactly this reason, and it is now copied into Task 3's Step 1 as required code rather than offered as a remedy.
