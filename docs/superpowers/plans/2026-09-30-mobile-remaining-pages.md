# Mobile Budgets, Goals, Settings and Breakdown (Stage 5 of the Phone Pass) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the last four pages work below `md`, and give every form control in the app a thumb-sized tap target on a phone.

**Architecture:** One task raises the shared control classes to a 44px minimum below `md`, which fixes every surface in the app at once rather than four pages in four ways. Three tasks then stack the layouts that assume width — `BudgetEditor`'s three-column grid, `GoalsList`'s fixed-width add form, and `CategoryManager`'s control rows. The fifth verifies a claim rather than assuming it: `BreakdownList` already looks compliant, and the task is to pin that with a test, not to manufacture a change.

**Tech Stack:** Next.js 16.3.5 (App Router, React 19.3.0), Tailwind, Vitest + @testing-library/react, jsdom.

**Spec:** `docs/superpowers/specs/2026-09-22-mobile-pass-design.md` — §7 is this stage, §3.1 the card shape breakdown is measured against, §8 the sequencing that puts it last.

## Global Constraints

- **Breakpoint is `md`.** Below `md` is the phone layout; `md` and up is today's desktop layout, unchanged. Stages 1-4 set this and stage 5 does not re-decide it.
- **Desktop output must not change.** Every change in this stage is gated below `md`, including the tap-target minimum. A diff visible at desktop width is a bug in this stage.
- **§7: "These four need no new interaction model, only layouts that do not assume a wide viewport."** No sheets, no new controls, no behaviour changes. If a task seems to need one, it is the wrong task.
- **§7: "Every form control goes full width with a minimum 44px tap height."**
- **Verify before claiming done:** `npx vitest run`, `npx tsc --noEmit`, `npm run lint`, `npm run build`, `npm run check:invariants`.

## Rulings carried into this plan

1. **The 44px minimum goes on the SHARED control classes, gated below `md` — not on Settings alone.** §7 states it in the Settings bullet, but the measurements make a per-page fix untenable: `inputClass` is `py-2 text-sm` (≈38px), `selectClass` is `py-1.5` (≈34px), and `buttonClass` is `h-8`/`h-10` (32/40px). **Every control in the app is under 44px on a phone**, including ones shipped in stages 1-4 — the category picker in the transactions sheet, the reimbursable editor, the refresh button. Fixing only Settings would leave the rest short while implying the rule had been applied. Gating below `md` keeps desktop byte-identical. *If this is wrong, the cost is slightly taller controls on a phone across the whole app, which is the stated goal.*

2. **Breakdown is verified, not rewritten.** §7 asks for "same card treatment as §3.1", and `components/BreakdownList.tsx:34-42` already renders `flex items-center justify-between` with `min-w-0`, `truncate` on the label and sub-line, and the amount on the right — which is §3.1's shape. Manufacturing a change to satisfy a checklist would risk a regression on a page that works. Task 5 pins the existing behaviour with a test and changes the component only if that test cannot be made to pass. *If this is wrong, the cost is that breakdown needed work and a test now documents that it did not get it — visible, not silent.*

3. **Settings' four cards already stack.** §7 asks that they "stack to one column"; `app/(app)/settings/page.tsx:58-94` is `space-y-6` wrapping four `<Card>`s with no grid at any width, so they already do. No task touches that page. *If this is wrong, the cost is nothing — a grid would be visible at a glance during the desktop check.*

4. **Goal rows are already compliant; only the add form is not.** §7 says `GoalsList` "needs its rows to stack and its progress bars to go full width". `components/GoalsList.tsx:112-122` already does both — `flex items-baseline justify-between` with `min-w-0 truncate`, and a bar that is `w-full`. The actual defect is the add form at `:47,:56`: `min-w-[12rem] flex-1` beside `w-32` in one flex row, where `min-w-[12rem]` specifically prevents the shrinking that would otherwise save it. Task 4 fixes the form and leaves the rows alone. *If this is wrong, the cost is that a goal row needed changing and did not get it — the device check would catch it.*

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `components/ui/styles.ts` | `inputClass` / `selectClass` gain a 44px minimum below `md` | 1 |
| `components/ui/Button.tsx` | `buttonClass` sizes gain the same | 1 |
| `components/BudgetEditor.tsx` | The three-column row stacks below `md` | 2 |
| `components/CategoryManager.tsx` | Rename/delete rows reachable at 390px | 3 |
| `components/GoalsList.tsx` | The add form stacks below `md` | 4 |
| `components/BreakdownList.tsx` | Verified against §3.1; changed only if verification fails | 5 |

Task 1 first — every other task's controls inherit from it. Tasks 2-5 are independent of each other.

---

### Task 1: A thumb-sized tap target, everywhere, below `md`

**Files:**
- Modify: `components/ui/styles.ts`, `components/ui/Button.tsx`
- Test: `tests/unit/control-tap-targets.test.ts` (new)

**Interfaces:**
- Consumes: nothing.
- Produces: no new exports. `inputClass`, `selectClass` and `buttonClass(variant, size)` keep their signatures and gain `min-h-[44px] md:min-h-0` (buttons: `md:h-8` / `md:h-10` restoring their exact current heights above `md`).

**Why a unit test on class strings:** jsdom computes no layout, so the class strings are the only evidence — the same approach stages 2-4 settled on after mutations proved rendering assertions could not see these properties.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/control-tap-targets.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { inputClass, selectClass } from '@/components/ui/styles'
import { buttonClass } from '@/components/ui/Button'

// §7: "Every form control goes full width with a minimum 44px tap height." Measured before this
// change: inputClass ≈38px (py-2 + text-sm), selectClass ≈34px (py-1.5), buttonClass 32px (h-8)
// and 40px (h-10). Every control in the app was under 44px on a phone, including the ones stages
// 1-4 shipped into the transactions sheet.
//
// Asserted on class strings because jsdom computes no layout — the same evidence stages 2-4 use
// for every other layout rule in this pass.
describe('control tap targets', () => {
  it('gives inputs a 44px minimum below md', () => {
    expect(inputClass).toContain('min-h-[44px]')
  })

  it('gives selects a 44px minimum below md', () => {
    expect(selectClass).toContain('min-h-[44px]')
  })

  // §7 also asks for full width, and selectClass was the one shared control without it. `inputClass`
  // has had `w-full` all along; a select sized to its content is the narrowest tap target in the app.
  it('gives selects the full width below md, and content width above it', () => {
    expect(selectClass).toContain('w-full')
    expect(selectClass).toContain('md:w-auto')
  })

  it('gives buttons a 44px minimum below md, at both sizes', () => {
    expect(buttonClass('primary', 'sm')).toContain('min-h-[44px]')
    expect(buttonClass('primary', 'md')).toContain('min-h-[44px]')
  })

  // Desktop must not change. The minimum is released at `md`, and the buttons restore the exact
  // heights they have today rather than merely dropping the floor.
  it('releases the minimum at md on every control', () => {
    expect(inputClass).toContain('md:min-h-0')
    expect(selectClass).toContain('md:min-h-0')
    expect(buttonClass('primary', 'sm')).toContain('md:h-8')
    expect(buttonClass('primary', 'md')).toContain('md:h-10')
  })

  // The sm/md distinction must survive — it is what makes a compact button compact on desktop.
  it('keeps the two button sizes distinct above md', () => {
    expect(buttonClass('primary', 'sm')).not.toContain('md:h-10')
    expect(buttonClass('primary', 'md')).not.toContain('md:h-8')
  })
})
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run tests/unit/control-tap-targets.test.ts`
Expected: FAIL — none of these classes exist yet.

- [ ] **Step 3: Raise the two shared strings**

In `components/ui/styles.ts`, add the minimum to both, keeping every other class exactly as it is:

```ts
// Shared class strings for consistent form controls across the app.
//
// `min-h-[44px] md:min-h-0`: §7 asks for a 44px minimum tap height on a phone, and every control
// here was under it — this one was ≈38px, the select ≈34px. Released at `md` so the desktop
// layouts stages 1-4 shipped are untouched; the padding below still sets the height there.

export const inputClass =
  'w-full min-h-[44px] md:min-h-0 rounded-xl border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-faint transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald/40'

export const selectClass =
  'w-full md:w-auto min-h-[44px] md:min-h-0 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-sm text-ink transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald/40 disabled:opacity-50'

export const labelClass = 'text-sm font-medium text-ink'
```

- [ ] **Step 4: Raise the button sizes**

Read `components/ui/Button.tsx` first. Replace the size map so each size keeps its exact desktop height and gains the phone minimum:

```ts
// `h-8`/`h-10` become desktop-only and a 44px minimum applies below `md` (§7). Written as
// `min-h-[44px] md:h-8` rather than by changing h-8 itself, so the desktop button is the height
// it has always been and only the phone changes.
const sizes: Record<Size, string> = {
  sm: 'min-h-[44px] md:h-8 md:min-h-0 px-3 text-sm',
  md: 'min-h-[44px] md:h-10 md:min-h-0 px-4 text-sm',
}
```

If the existing map is written differently, adapt rather than transcribe — the requirement is that `h-8`/`h-10` apply from `md` up and a 44px minimum applies below it.

- [ ] **Step 5: Run the tests and watch them pass**

Run: `npx vitest run tests/unit/control-tap-targets.test.ts && npx vitest run && npx tsc --noEmit && npm run lint`
Expected: all clean. The full suite matters here — these classes are asserted by tests from stages 1-4 (`stat-card`, `account-list`, `category-picker`), and any that pin a full class string will need updating. **Update those assertions to match; do not weaken them back to `toContain`.**

- [ ] **Step 6: Check the tests bite**

Mutate and confirm each is caught, restoring after every one:

- drop `md:min-h-0` from `inputClass` → the desktop test must fail
- swap the two button sizes' `md:h-*` values → the distinctness test must fail
- drop `min-h-[44px]` from `selectClass` → the select test must fail
- drop `md:w-auto` from `selectClass` → the select-width test must fail. Then check the desktop
  transactions table by eye: `CategoryPicker` uses this class inside a `<td>`, so `w-full` reaching
  desktop would stretch the picker across the category column — the exact regression stage 2 avoided
  with a Fragment. Confirm `md:w-auto` prevents it.

Record all three results.

- [ ] **Step 7: Commit**

```bash
git add components/ui/styles.ts components/ui/Button.tsx tests/unit/control-tap-targets.test.ts
git commit -m "Give every control a 44px tap target below md"
```

---

### Task 2: Budgets stack below `md`

**Files:**
- Modify: `components/BudgetEditor.tsx`
- Test: `tests/unit/budget-editor.test.tsx` (create if absent; check first)

**Interfaces:**
- Consumes: the raised control classes (Task 1).
- Produces: no signature change.

**The defect:** `components/BudgetEditor.tsx:55` is `grid grid-cols-[1fr_auto_7rem] items-center gap-3`. On a 390px phone that is a category name plus a progress bar, an "$X spent" figure, and a 7rem (112px) number input, all on one line. §7 asks for: "one budget row per line below `md`: category, a full-width progress bar, and amount-spent / amount-budgeted beneath it."

- [ ] **Step 1: Write the failing tests**

Check whether `tests/unit/budget-editor.test.tsx` exists; create it if not, matching the setup of `tests/unit/reimbursable-editor.test.tsx` (same kind of client component with state). Add:

```tsx
  // §7: below `md` a budget row is one line per field, not three columns in 390px. The grid
  // becomes a single column and reinstates the three tracks at `md`.
  it('stacks a budget row below md and restores the columns above it', () => {
    const { container } = render(<BudgetEditor {...props} />)
    const row = container.querySelector('[data-budget-row]') as HTMLElement
    expect(row.className).toContain('grid-cols-1')
    expect(row.className).toContain('md:grid-cols-[1fr_auto_7rem]')
  })

  // The input is the control most squeezed by the old layout — 7rem inside a 390px row.
  it('gives the limit input the full width below md', () => {
    const { container } = render(<BudgetEditor {...props} />)
    const input = container.querySelector('input[type="number"]') as HTMLElement
    expect(input.className).toContain('w-full')
    expect(input.className).toContain('md:w-28')
  })
```

Use whatever props the component requires — read its signature and build the smallest fixture with at least two categories, one of them over its limit so the coral branch renders.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run tests/unit/budget-editor.test.tsx`
Expected: FAIL — the row has no `data-budget-row`, and the classes are the desktop-only ones.

- [ ] **Step 3: Stack the row**

At `components/BudgetEditor.tsx:55`, change the row's className and add the test hook:

```tsx
            <div
              key={c}
              data-budget-row
              className="grid grid-cols-1 items-start gap-2 border-b border-line py-3 last:border-0 md:grid-cols-[1fr_auto_7rem] md:items-center md:gap-3"
            >
```

`items-start` below `md` because stacked rows read better top-aligned; `md:items-center` restores today's alignment. `gap-2` tightens the vertical rhythm and `md:gap-3` restores the horizontal one.

Then give the input its full width below `md` — at the line currently reading `className={`${inputClass} w-28 text-right`}`:

```tsx
                className={`${inputClass} w-full text-right md:w-28`}
```

Remove `max-w-xs` from the progress bar's wrapper so the bar genuinely fills the row below `md`, and restore it above:

```tsx
                <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-line md:max-w-xs">
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run tests/unit/budget-editor.test.tsx && npx vitest run && npx tsc --noEmit && npm run lint`
Expected: all clean.

- [ ] **Step 5: Check the tests bite**

Mutate and confirm each is caught, restoring after every one:

- revert the row to `grid-cols-[1fr_auto_7rem]` with no `md:` prefix → the stacking test must fail
- revert the input to `w-28` → the input test must fail

Record both results.

- [ ] **Step 6: Commit**

```bash
git add components/BudgetEditor.tsx tests/unit/budget-editor.test.tsx
git commit -m "Stack a budget row below md"
```

---

### Task 3: Settings controls reachable at 390px

**Files:**
- Modify: `components/CategoryManager.tsx`
- Test: `tests/unit/category-manager.test.tsx` (create if absent; check first)

**Interfaces:**
- Consumes: the raised control classes (Task 1).
- Produces: no signature change.

**The defect:** `components/CategoryManager.tsx:61` and `:108` are `flex max-w-md gap-2` rows holding an input (`flex-1`) plus buttons. §7: "`CategoryManager` with 18 categories needs its rename/delete controls reachable without horizontal scroll."

Read the whole component first — it has both an add form and a per-category row, and they need the same treatment. **Do not touch `app/(app)/settings/page.tsx`**: Ruling 3 establishes that its four cards already stack, so there is nothing to change there.

- [ ] **Step 1: Write the failing tests**

Check whether `tests/unit/category-manager.test.tsx` exists; create it if not. Add:

```tsx
  // §7: the rename/delete controls must be reachable at 390px without horizontal scroll. The row
  // wraps below `md` so a long category name cannot push the buttons off-screen, and reverts to
  // one line above it.
  it('lets a category row wrap below md', () => {
    const { container } = render(<CategoryManager {...props} />)
    const row = container.querySelector('[data-category-row]') as HTMLElement
    expect(row.className).toContain('flex-wrap')
    expect(row.className).toContain('md:flex-nowrap')
  })

  it('does not cap the row width below md', () => {
    const { container } = render(<CategoryManager {...props} />)
    const row = container.querySelector('[data-category-row]') as HTMLElement
    expect(row.className).toContain('md:max-w-md')
    expect(row.className.split(/\s+/)).not.toContain('max-w-md')
  })
```

The second test's `.split(/\s+/)` and `not.toContain` is deliberate: a plain `not.toContain('max-w-md')` on the whole string would also match `md:max-w-md` and fail against correct code. Build the fixture with at least one long category name.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run tests/unit/category-manager.test.tsx`
Expected: FAIL — no `data-category-row`, and the row is unconditionally `max-w-md` with no wrapping.

- [ ] **Step 3: Let the rows wrap**

At `components/CategoryManager.tsx:108` (the per-category row), add the hook and the breakpoint classes:

```tsx
    <div data-category-row className="flex flex-wrap items-center gap-2 md:max-w-md md:flex-nowrap">
```

Apply the same `flex-wrap md:max-w-md md:flex-nowrap` treatment to the add form at `:61`, keeping its own `pt-3`.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run tests/unit/category-manager.test.tsx && npx vitest run && npx tsc --noEmit && npm run lint`
Expected: all clean.

- [ ] **Step 5: Check the tests bite**

Mutate and confirm each is caught, restoring after every one:

- remove `flex-wrap` → the wrapping test must fail
- change `md:max-w-md` back to bare `max-w-md` → the width test must fail

Record both results.

- [ ] **Step 6: Commit**

```bash
git add components/CategoryManager.tsx tests/unit/category-manager.test.tsx
git commit -m "Let the category rows wrap on a phone"
```

---

### Task 4: The goals add form stacks

**Files:**
- Modify: `components/GoalsList.tsx`
- Test: `tests/unit/goals-list.test.tsx` (create if absent; check first)

**Interfaces:**
- Consumes: the raised control classes (Task 1).
- Produces: no signature change.

**The defect, and what is NOT the defect:** the goal *rows* at `components/GoalsList.tsx:112-122` already satisfy §7 — `flex items-baseline justify-between` with `min-w-0 truncate`, and a bar that is already `w-full`. **Leave them alone.** The add form is the problem: `:47` is `min-w-[12rem] flex-1` beside `:56`'s `w-32` in one flex row, and `min-w-[12rem]` specifically blocks the shrinking that would otherwise rescue it at 390px.

- [ ] **Step 1: Write the failing tests**

Check whether `tests/unit/goals-list.test.tsx` exists; create it if not. Add:

```tsx
  // The Goal field's min-w-[12rem] blocks the shrink that would otherwise let this row fit a
  // 390px screen beside the w-32 Target field. Below `md` the form stacks; above it, today's
  // side-by-side layout is restored exactly.
  it('stacks the add form below md', () => {
    const { container } = render(<GoalsList {...props} />)
    const form = container.querySelector('form') as HTMLElement
    expect(form.className).toContain('flex-col')
    expect(form.className).toContain('md:flex-row')
  })

  it('does not floor the Goal field width below md', () => {
    const { container } = render(<GoalsList {...props} />)
    const label = container.querySelector('[data-goal-name-field]') as HTMLElement
    expect(label.className).toContain('md:min-w-[12rem]')
    expect(label.className.split(/\s+/)).not.toContain('min-w-[12rem]')
  })

  // Guards Ruling 3: the goal rows were already compliant and this task must not disturb them.
  it('leaves the goal row progress bars full width', () => {
    const { container } = render(<GoalsList {...props} />)
    const bars = [...container.querySelectorAll('div')].filter((d) =>
      d.className.includes('rounded-full') && d.className.includes('w-full')
    )
    expect(bars.length).toBeGreaterThan(0)
  })
```

Build the fixture with at least one goal so a row renders.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run tests/unit/goals-list.test.tsx`
Expected: FAIL on the first two; the third may pass already, which is the point — it is a regression guard for something already correct.

- [ ] **Step 3: Stack the form**

Read the `<form>` element's current className and add the stacking, keeping everything else:

```tsx
        className="flex flex-col gap-3 md:flex-row md:items-end"
```

Adapt to whatever classes are already there — the requirement is `flex-col` below `md` and today's row behaviour from `md` up.

Then at `:47`, add the hook and move the floor behind the breakpoint:

```tsx
          <label data-goal-name-field className="flex flex-1 flex-col gap-1.5 md:min-w-[12rem]">
```

And at `:56`, let the Target field fill the width below `md`:

```tsx
          <label className="flex w-full flex-col gap-1.5 md:w-32">
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run tests/unit/goals-list.test.tsx && npx vitest run && npx tsc --noEmit && npm run lint`
Expected: all clean.

- [ ] **Step 5: Check the tests bite**

Mutate and confirm each is caught, restoring after every one:

- remove `flex-col` from the form → the stacking test must fail
- change `md:min-w-[12rem]` back to bare `min-w-[12rem]` → the floor test must fail

Record both results.

- [ ] **Step 6: Commit**

```bash
git add components/GoalsList.tsx tests/unit/goals-list.test.tsx
git commit -m "Stack the goals add form below md"
```

---

### Task 5: Verify breakdown, do not rewrite it

**Files:**
- Test: `tests/unit/breakdown-list.test.tsx` (create if absent; check first)
- Modify: `components/BreakdownList.tsx` — **only if the verification below fails**

**Interfaces:**
- Consumes: nothing.
- Produces: no signature change.

**This task's deliverable is a test, not a change.** §7 asks breakdown for "same card treatment as §3.1, no sheet since there is nothing to edit". `components/BreakdownList.tsx:34-42` already renders `flex items-center justify-between py-3` with `min-w-0` on the text block, `truncate` on both the label and the sub-line, and the amount on the right — which is §3.1's shape. Manufacturing a change to satisfy a checklist would risk a regression on a page that works.

Write the test that pins that shape. If it passes on the existing component, the task is done and the component is untouched — say so explicitly in your report. If it fails, fix the component minimally so it passes, and say what was actually wrong.

- [ ] **Step 1: Write the test**

Create `tests/unit/breakdown-list.test.tsx`:

```tsx
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { BreakdownList } from '@/components/BreakdownList'

afterEach(cleanup)

const rows = [
  { key: 'a', label: 'Capital One Checking', sub: 'depository', amount: 1234.56, currency: 'USD' },
  { key: 'b', label: 'A'.repeat(60), sub: null, amount: 78.9, currency: 'USD', owed: true },
]

describe('BreakdownList', () => {
  it('shows the label and the amount', () => {
    render(<BreakdownList rows={rows} />)
    expect(screen.getByText('Capital One Checking')).toBeTruthy()
    expect(screen.getByText('$1,234.56')).toBeTruthy()
  })

  // §3.1's shape, which §7 asks this page to match: a long label truncates rather than pushing the
  // amount off a 390px screen. This is a regression guard for behaviour that already exists — the
  // component was verified compliant rather than rewritten (Ruling 2).
  it('truncates a long label instead of displacing the amount', () => {
    render(<BreakdownList rows={rows} />)
    expect(screen.getByText('A'.repeat(60)).className).toContain('truncate')
  })

  it('keeps the text block shrinkable so truncation can engage', () => {
    const { container } = render(<BreakdownList rows={rows} />)
    const shrinkable = [...container.querySelectorAll('div')].filter((d) =>
      d.className.split(/\s+/).includes('min-w-0')
    )
    expect(shrinkable.length).toBeGreaterThan(0)
  })

  it('renders a liability as a negative', () => {
    render(<BreakdownList rows={rows} />)
    expect(screen.getByText('−$78.90')).toBeTruthy()
  })

  it('says so when there is nothing to show', () => {
    render(<BreakdownList rows={[]} />)
    expect(screen.getByText('Nothing to show here yet.')).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run it and record what happens**

Run: `npx vitest run tests/unit/breakdown-list.test.tsx`

**Expected: PASS without any component change.** That is the outcome Ruling 2 predicts. If it passes, report "verified compliant, component untouched" and go to Step 4.

If any test fails, that is a real finding: the component does not match §3.1 after all. Report exactly which assertion failed and what the markup actually is.

- [ ] **Step 3: Fix only what failed**

Only if Step 2 failed. Change `components/BreakdownList.tsx` minimally so the failing assertion passes — do not restructure the component, and do not change anything the tests did not catch. Re-run until green.

If Step 2 passed, skip this step entirely and record that you skipped it.

- [ ] **Step 4: Check the test bites**

A test that passes on unchanged code needs proof it is not vacuous. Mutate and confirm, restoring after each:

- remove `truncate` from the label `<p>` → the truncation test must fail
- remove `min-w-0` from the text block → the shrinkable test must fail

Record both results. If either mutation survives, the test is not pinning what it claims and must be strengthened before this task is done.

- [ ] **Step 5: Commit**

```bash
git add tests/unit/breakdown-list.test.tsx
git commit -m "Pin the breakdown list's phone layout"
```

Add `components/BreakdownList.tsx` to that command only if Step 3 changed it.

---

## Finishing the stage

- [ ] **Full verification, fresh:**

```bash
npx vitest run && npx tsc --noEmit && npm run lint && npm run build && npm run check:invariants
```

Report the actual numbers, not "should pass".

- [ ] **Confirm the tap-target rule reached everything.** `grep -rn "inputClass\|selectClass\|buttonClass" components/ app/ | wc -l` — every one of those call sites now inherits the 44px minimum. Spot-check that no component overrides it with its own shorter height.

- [ ] **Desktop diff check.** Load `/budgets`, `/goals`, `/settings` and a `/breakdown/<metric>` page at desktop width. Every one must look exactly as it did: budgets in three columns, the goals form on one line, category rows capped at `max-w-md`, and control heights unchanged. A visible difference at desktop width is a Global Constraint violation.

- [ ] **Ask the owner to check on their actual phone** via the PR's Vercel preview, and name three things and no more:
  1. Budgets — each category is one block: name, a full-width bar, the spent figure and the limit input beneath, with the input easy to hit.
  2. Settings — the category list's rename and delete controls are reachable without sideways scrolling, with 18 categories.
  3. Goals — adding a goal is possible without the two fields fighting for the same line.

  Say plainly whether the preview has rebuilt since the last push.

- [ ] **Anything found that does not belong in this branch becomes an issue**, per `.claude/rules/filing-issues.md`.

- [ ] **This is the last stage of the phone pass.** When it merges, update the mobile-pass memory to record the project complete rather than leaving a stage 6 implied.
