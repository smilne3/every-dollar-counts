# Mobile Trends (Stage 4 of the Phone Pass) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the period-over-period chart readable on a phone — horizontal bars below `md`, capped at the top 6 plus an expandable "Other" — and replace a comparison colour that fails contrast at every width.

**Architecture:** `SpendByCategoryChart` is already horizontal and already works on a phone; `PeriodOverPeriodChart` becomes the same shape below `md` by rendering a second recharts instance with `layout="vertical"` (recharts' name for horizontal bars) and CSS-gating the two, the idiom stages 1-3 used. The category cap is a pure function over the already-sorted rows, so it is testable without rendering. The palette moves to one exported constant that both charts import, which is what makes the §9 palette test possible.

**Tech Stack:** Next.js 16.3.5 (App Router, React 19.3.0), recharts, Tailwind, Vitest + @testing-library/react, jsdom.

**Spec:** `docs/superpowers/specs/2026-09-22-mobile-pass-design.md` — §5 is this stage, §5.1 the palette change, §1.4 the defect it closes, §9 the tests it owes.

## Global Constraints

- **Breakpoint is `md`.** Below `md` is the phone layout; `md` and up is today's desktop layout. Stages 1-3 set this and stage 4 does not re-decide it.
- **The palette change applies at EVERY width.** §5.1: "This is the one change in this spec that is **not** phone-only. A series at 1.56:1 contrast is not a mobile defect; it is a defect that mobile made obvious." `#c9cec7` → `#0369a1` on desktop too.
- **Everything else about the desktop chart is unchanged** — still vertical, still every category, same axes, same tooltip, same legend, same height.
- **The cap is phone-only.** §5: "Categories are capped at the top 6 plus a tappable 'Other' below `md`." Desktop keeps every category.
- **`#95` is out of scope.** §5.2 files the "what changed" view separately and explains why it must be a toggle on top of this chart rather than a replacement: Loan Payments is $3,929.35 in both windows, so its delta is $0 and it would not render at all.
- **Verify before claiming done:** `npx vitest run`, `npx tsc --noEmit`, `npm run lint`, `npm run build`, `npm run check:invariants`.

## Rulings carried into this plan

1. **Two CSS-gated chart instances, not a viewport hook.** `PeriodOverPeriodChart` is `'use client'`, so `matchMedia` is available — but a hook must pick one layout for the server render, which then flips after hydration on whichever device guessed wrong. Rendering both and letting CSS choose flashes on neither, and is the idiom stages 1-3 already ship. The cost is that the hidden instance's `ResponsiveContainer` measures 0 and renders nothing; recharts may log a dev-only width warning, which Task 3 verifies. *If this is wrong, the cost is a duplicate chart in the DOM and a console warning.*

2. **"Tappable Other" is a button beneath the chart, not a click target on the bar.** §5 says "Tapping 'Other' expands the remainder." A recharts `<Bar>` segment is a poor tap target with no affordance, and `components/AccountList.tsx` already established this codebase's disclosure idiom ("Show all N" / "Show fewer", with `aria-expanded`). The Other bar still renders — it is what shows the remainder's size — and the button is what expands it. *If this is wrong, the cost is one extra control below the chart instead of a direct tap.*

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `lib/chart-palette.ts` | **New.** The validated series pair, imported by every chart | 1 |
| `components/PeriodOverPeriodChart.tsx` | Imports the palette; gains the horizontal layout and the cap | 1, 3, 4 |
| `components/SpendByCategoryChart.tsx` | Imports the palette instead of its own literal | 1 |
| `components/SpendIncomeChart.tsx` | Imports the palette instead of its own literal | 1 |
| `lib/trends.ts` | Gains `capCategories`, a pure function over the sorted rows | 2 |

Tasks 1 and 2 are independent. Task 3 depends on 1. Task 4 depends on 2 and 3.

---

### Task 1: One validated palette

**Files:**
- Create: `lib/chart-palette.ts`
- Modify: `components/PeriodOverPeriodChart.tsx`, `components/SpendByCategoryChart.tsx`, `components/SpendIncomeChart.tsx`, `tests/unit/period-over-period-chart.test.tsx` (it asserts the old hex literals directly — retarget them at `CHART_SERIES` rather than hardcoding the new value, so the pair stays pinned in one place)
- Test: `tests/unit/chart-palette.test.ts` (new)

**Interfaces:**
- Consumes: nothing.
- Produces: `CHART_SERIES: { readonly primary: '#0e9f6e'; readonly comparison: '#0369a1' }`

**What this fixes:** `#c9cec7` measures 1.56:1 against the surface. §5.1 pairs `#0369a1` with the existing `#0e9f6e` and reports it passes all six checks in light mode and holds in dark with a single 2.94:1 WARN that the direct amount labels discharge.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/chart-palette.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { CHART_SERIES } from '@/lib/chart-palette'

describe('CHART_SERIES', () => {
  // §9: "a test asserting the chart constants are the validated pair, so a future colour change
  // has to be deliberate." These two hex values were measured together — changing either one
  // without re-measuring is what this test exists to stop.
  it('is the validated pair', () => {
    expect(CHART_SERIES.primary).toBe('#0e9f6e')
    expect(CHART_SERIES.comparison).toBe('#0369a1')
  })

  // The value this replaced. 1.56:1 against the surface, failing two palette checks — the whole
  // reason §5.1 exists. Named here so it cannot quietly come back.
  it('does not use the grey that failed contrast', () => {
    expect(Object.values(CHART_SERIES)).not.toContain('#c9cec7')
  })
})
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run tests/unit/chart-palette.test.ts`
Expected: FAIL — `lib/chart-palette.ts` does not exist.

- [ ] **Step 3: Create the module**

Create `lib/chart-palette.ts`:

```ts
// The two series colours every chart draws with, measured as a PAIR.
//
// `previous` was #c9cec7 until spec §5.1. That grey measured 1.56:1 against the surface and failed
// two palette checks — a series you cannot see is not a comparison. #0369a1 against the existing
// #0e9f6e passes all six checks in light mode and holds in dark mode with a single 2.94:1 warning,
// which the direct amount labels discharge.
//
// Not phone-only, deliberately: a contrast failure is not a mobile defect, it is a defect mobile
// made obvious. Applying it below `md` alone would leave the desktop chart failing the same check
// for no reason.
//
// Here rather than inline in each chart so the §9 test has one thing to pin — three copies of a
// hex literal is three places a future change can half-happen.
export const CHART_SERIES = {
  // The brand emerald. The single series in SpendByCategoryChart and SpendIncomeChart, and the
  // CURRENT window wherever two windows are compared.
  primary: '#0e9f6e',
  // The PRIOR window. Named for its role rather than its colour so a future palette change does
  // not leave three call sites reading `CHART_SERIES.blue`.
  comparison: '#0369a1',
} as const
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run tests/unit/chart-palette.test.ts`
Expected: PASS, both.

- [ ] **Step 5: Point all three charts at it**

In `components/PeriodOverPeriodChart.tsx`, delete these two lines:

```ts
const EMERALD = '#0e9f6e'
const GRAY = '#c9cec7'
```

add `import { CHART_SERIES } from '@/lib/chart-palette'`, and change the two `<Bar>` fills: the first `<Bar>` (`dataKey="previous"`) becomes `fill={CHART_SERIES.comparison}`, the second (`dataKey="current"`) becomes `fill={CHART_SERIES.primary}`.

In `components/SpendByCategoryChart.tsx`, delete `const EMERALD = '#0e9f6e'`, add the same import, and change its `<Bar>` to `fill={CHART_SERIES.primary}`.

In `components/SpendIncomeChart.tsx`, delete `const EMERALD = '#0e9f6e'`, add the same import, and replace every use of `EMERALD` with `CHART_SERIES.primary`. Read that file first — it may use the constant in more than one place.

- [ ] **Step 6: Confirm the literal is gone**

Run: `grep -rn "'#c9cec7'" components/ lib/ app/` — the QUOTED literal, i.e. the value rather
than a mention of it.
Expected: no output. Note that a bare `grep -rn "#c9cec7"` will still hit `lib/chart-palette.ts`,
because the comment above the constant names the colour it replaced on purpose. Then `grep -rn "#0e9f6e" components/ lib/ app/` — the only hits should be `lib/chart-palette.ts` and `app/globals.css:15` (the CSS custom property, a separate thing that is not a chart series).

- [ ] **Step 7: Run everything**

Run: `npx vitest run && npx tsc --noEmit && npm run lint`
Expected: all clean.

- [ ] **Step 8: Commit**

```bash
git add lib/chart-palette.ts tests/unit/chart-palette.test.ts components/PeriodOverPeriodChart.tsx components/SpendByCategoryChart.tsx components/SpendIncomeChart.tsx
git commit -m "Replace the comparison grey that measured 1.56:1"
```

---

### Task 2: `capCategories`

**Files:**
- Modify: `lib/trends.ts`
- Test: `tests/unit/trends-view.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:

```ts
export type CompareRow = { category: string; current: number; previous: number }
export function capCategories(
  rows: CompareRow[],
  limit?: number   // default 6
): { shown: CompareRow[]; other: CompareRow | null }
```

`other.category` is the literal `'Other'`. `other` is `null` when nothing was folded.

**Why a pure function:** §9 asks for exactly this — "Trends caps at six categories plus Other below `md`, and Other's amount equals the sum of the remainder. A pure function over the rows; no rendering required."

**The rows arrive already sorted.** `lib/trends.ts` sorts them `b.current + b.previous - (a.current + a.previous)` descending, so "top 6" is the first 6 and this function must not re-sort.

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/trends-view.test.ts`:

```ts
describe('capCategories', () => {
  const row = (category: string, current: number, previous: number) => ({ category, current, previous })

  it('returns everything and no Other when there is nothing to fold', () => {
    const rows = [row('A', 5, 4), row('B', 3, 2)]
    const { shown, other } = capCategories(rows)
    expect(shown).toEqual(rows)
    expect(other).toBeNull()
  })

  it('keeps exactly the limit and folds the rest', () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(`C${i}`, 10 - i, 0))
    const { shown, other } = capCategories(rows, 6)
    expect(shown.map((r) => r.category)).toEqual(['C0', 'C1', 'C2', 'C3', 'C4', 'C5'])
    expect(other!.category).toBe('Other')
  })

  // The assertion §9 names. Other is the remainder, both windows, or the chart lies about the size
  // of what it is hiding.
  it("Other's amounts are the sum of the folded rows, per window", () => {
    const rows = [
      row('A', 100, 90),
      row('B', 80, 70),
      row('C', 60, 50),
      row('D', 40, 30),
      row('E', 20, 10),
      row('F', 10, 5),
      row('G', 3, 2),
      row('H', 1, 1),
    ]
    const { other } = capCategories(rows, 6)
    expect(other!.current).toBe(4)
    expect(other!.previous).toBe(3)
  })

  it('does not re-sort rows that arrive ordered', () => {
    const rows = [row('Big', 100, 0), row('Small', 1, 0), row('Mid', 50, 0)]
    expect(capCategories(rows, 3).shown.map((r) => r.category)).toEqual(['Big', 'Small', 'Mid'])
  })

  // Exactly at the limit folds nothing — an "Other" worth $0 is noise with a tap target on it.
  it('folds nothing when the row count equals the limit', () => {
    const rows = Array.from({ length: 6 }, (_, i) => row(`C${i}`, 1, 1))
    expect(capCategories(rows, 6).other).toBeNull()
  })

  // Float addition on money: 0.1 + 0.2 is 0.30000000000000004, and the chart would render it.
  it('rounds the folded sums to cents', () => {
    const rows = [
      ...Array.from({ length: 6 }, (_, i) => row(`C${i}`, 100 - i, 0)),
      row('X', 0.1, 0.1),
      row('Y', 0.2, 0.2),
    ]
    const { other } = capCategories(rows, 6)
    expect(other!.current).toBe(0.3)
    expect(other!.previous).toBe(0.3)
  })

  it('is safe on an empty list', () => {
    expect(capCategories([], 6)).toEqual({ shown: [], other: null })
  })
})
```

Add `capCategories` to the existing `@/lib/trends` import at the top of the file.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run tests/unit/trends-view.test.ts`
Expected: FAIL — `capCategories is not a function`.

- [ ] **Step 3: Implement it**

In `lib/trends.ts`, below the existing exports. Reuse the file's existing `cents` helper rather than writing another rounder — read it first and match how it is called:

```ts
export type CompareRow = { category: string; current: number; previous: number }

// The top `limit` categories, plus one synthetic "Other" carrying everything below the line.
//
// Below `md` the comparison chart has room for about six bars; the household's bottom 7 categories
// total $665 of $11,600, so capping hides about 6% (spec §5). Other must carry the remainder in
// BOTH windows — a chart that hid $665 behind a bar sized from one window would misstate exactly
// the thing the reader is comparing.
//
// `rows` arrive sorted by combined size from buildTrendsView, so "top" is just the first N. This
// does not re-sort: a second sort here could disagree with the order the desktop chart draws, and
// the two would then hide different categories.
export function capCategories(
  rows: CompareRow[],
  limit = 6
): { shown: CompareRow[]; other: CompareRow | null } {
  if (rows.length <= limit) return { shown: rows, other: null }
  const rest = rows.slice(limit)
  return {
    shown: rows.slice(0, limit),
    other: {
      category: 'Other',
      current: cents(rest.reduce((s, r) => s + r.current, 0)),
      previous: cents(rest.reduce((s, r) => s + r.previous, 0)),
    },
  }
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run tests/unit/trends-view.test.ts && npx vitest run`
Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/trends.ts tests/unit/trends-view.test.ts
git commit -m "Add capCategories, the top N plus an honest Other"
```

---

### Task 3: Horizontal bars below `md`

**Files:**
- Modify: `components/PeriodOverPeriodChart.tsx`
- Test: `tests/unit/period-over-period-chart.test.tsx`

**Interfaces:**
- Consumes: `CHART_SERIES` (Task 1).
- Produces: no signature change — the component's props stay `{ data, currentLabel, previousLabel }`.

**The shape to copy:** `components/SpendByCategoryChart.tsx` is already horizontal and already works on a phone. In recharts, horizontal bars come from `layout="vertical"` on `<BarChart>`, with `<XAxis type="number">` and `<YAxis type="category" dataKey=... width={130}>`. Read that file before starting — this task is making the comparison chart the same shape.

**Why two instances:** see Ruling 1. The desktop chart keeps `layout` unset (recharts' default, vertical bars) and every axis prop it has today. The phone chart is a second `<ResponsiveContainer>` in a `md:hidden` wrapper, with the desktop one wrapped `hidden md:block`.

**Height differs.** The desktop chart is a fixed 340px. The phone chart grows with its rows, like `SpendByCategoryChart`: `Math.max(200, rows * 56)` — 56 rather than 40 because each category here carries two bars, not one.

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/period-over-period-chart.test.tsx`. It already stubs `ResizeObserver` and the element box in `beforeAll`, so both instances render:

```tsx
  // §1.4: the vertical chart puts 26 bars in ~273px under 13 labels rotated -40°, which collide.
  // Horizontal bars need no rotated labels at all, so the collision goes away by construction
  // rather than by tuning font sizes (spec §5).
  it('renders a phone chart and a desktop chart, gated on the breakpoint', () => {
    const { container } = render(
      <PeriodOverPeriodChart data={rows} currentLabel="Sep" previousLabel="Aug" />
    )
    const classes = [...container.querySelectorAll('div')].map((d) => d.className)
    expect(classes).toContain('md:hidden')
    expect(classes.some((c) => c.includes('hidden') && c.includes('md:block'))).toBe(true)
  })

  // The desktop chart is unchanged, which means it keeps the rotated labels. If this ever stops
  // being true the desktop layout has been altered by a phone-only stage.
  it('keeps the rotated category labels on the desktop chart only', () => {
    const { container } = render(
      <PeriodOverPeriodChart data={rows} currentLabel="Sep" previousLabel="Aug" />
    )
    const desktop = container.querySelector('.md\\:block')!
    const phone = container.querySelector('.md\\:hidden')!
    expect(desktop.innerHTML).toContain('rotate(-40')
    expect(phone.innerHTML).not.toContain('rotate(-40')
  })
```

recharts renders a rotated tick as `<text transform="rotate(-40, x, y)">`, which is what that
substring targets. If the RED run shows it emits the rotation in some other form, pin whatever it
actually emits rather than deleting the assertion — the point is that the phone chart has no
rotated labels and the desktop one still does.

```tsx
```

Use whatever fixture the file already defines for `rows`; if it has none, add `const rows = [{ category: 'Food', current: 10, previous: 8 }, { category: 'Rent', current: 5, previous: 6 }]` next to the existing setup.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run tests/unit/period-over-period-chart.test.tsx`
Expected: FAIL — there is one chart and no breakpoint wrappers.

- [ ] **Step 3: Restructure the component**

Keep the existing `<BarChart>` exactly as it is and wrap it, then add the phone chart above it. The whole return becomes:

```tsx
  const phoneHeight = Math.max(200, data.length * 56)
  return (
    <>
      {/* Horizontal below `md`. recharts calls this layout="vertical" — the name describes the
          axis arrangement, not the bars. Copied from SpendByCategoryChart, which is already this
          shape and already works on a phone. No rotated labels means §1.4's collision cannot
          recur by construction. */}
      <div className="md:hidden" style={{ width: '100%', height: phoneHeight }}>
        <ResponsiveContainer>
          <BarChart data={data} layout="vertical" margin={{ left: 4, right: 16 }} barGap={2}>
            <CartesianGrid horizontal={false} stroke="#e6e9e3" />
            <XAxis
              type="number"
              tickFormatter={(v) => `$${v}`}
              tickLine={false}
              axisLine={false}
              tick={{ fill: '#8b948c', fontSize: 11 }}
            />
            <YAxis
              type="category"
              dataKey="category"
              width={110}
              tickLine={false}
              axisLine={false}
              tick={{ fill: '#5f6b64', fontSize: 12 }}
            />
            <Tooltip
              formatter={(v) => `$${v}`}
              cursor={{ fill: 'rgba(20,35,28,0.04)' }}
              contentStyle={{
                borderRadius: 12,
                border: '1px solid #e6e9e3',
                fontSize: 13,
                boxShadow: '0 4px 12px rgba(20,35,28,0.08)',
              }}
            />
            <Legend
              iconType="circle"
              iconSize={9}
              wrapperStyle={{ fontSize: 12, color: '#5f6b64', paddingTop: 4 }}
            />
            <Bar dataKey="previous" name={previousLabel} fill={CHART_SERIES.comparison} radius={[0, 4, 4, 0]} maxBarSize={14} isAnimationActive={false} />
            <Bar dataKey="current" name={currentLabel} fill={CHART_SERIES.primary} radius={[0, 4, 4, 0]} maxBarSize={14} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Unchanged from before this stage apart from the series colour (§5.1). The rotated labels
          stay here: at desktop width they have the room they never had on a phone. */}
      <div className="hidden md:block" style={{ width: '100%', height: 340 }}>
        <ResponsiveContainer>
          {/* The entire existing <BarChart>…</BarChart> element, moved here without a single edit
              to it — same margin, barGap, CartesianGrid, XAxis with angle={-40}, YAxis, Tooltip,
              Legend and both Bars. Only the two `fill` props changed, and Task 1 changed those. */}
        </ResponsiveContainer>
      </div>
    </>
  )
```

Move the existing `<BarChart>` into the second wrapper without editing it. The outer `<div style={{ width: '100%', height: 340 }}>` that used to wrap everything is replaced by these two wrappers.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run tests/unit/period-over-period-chart.test.tsx && npx vitest run && npx tsc --noEmit && npm run lint`
Expected: all clean.

- [ ] **Step 5: Check the tests bite**

Mutate and confirm each is caught, restoring after every one:

- remove `md:hidden` from the phone wrapper → the breakpoint test must fail
- remove `hidden md:block` from the desktop wrapper → the breakpoint test must fail
- add `angle={-40} textAnchor="end"` to the phone chart's `YAxis` → the rotated-label test must fail

Record all three results.

- [ ] **Step 6: Check the console in a real browser**

Ruling 1 accepts that the hidden instance measures 0 and renders nothing. Confirm what that costs: run `npm run dev`, open `/trends` at desktop width, and read the browser console.

- If recharts logs a width/height warning, note the exact text in your report. It is cosmetic and does not block — but say so rather than leaving it for someone to discover.
- If it logs nothing, say that.

Either way, also confirm by eye that the desktop chart looks as it did and that only one chart is visible at each width.

- [ ] **Step 7: Commit**

```bash
git add components/PeriodOverPeriodChart.tsx tests/unit/period-over-period-chart.test.tsx
git commit -m "Rotate the comparison chart to horizontal below md"
```

---

### Task 4: Top 6 plus an expandable Other

**Files:**
- Modify: `components/PeriodOverPeriodChart.tsx`
- Test: `tests/unit/period-over-period-chart.test.tsx`

**Interfaces:**
- Consumes: `capCategories` (Task 2), the phone chart from Task 3.
- Produces: no signature change.

**Scope:** the cap applies to the phone chart only. The desktop chart keeps every category — it has the width, and widening this stage to desktop would contradict the Global Constraints.

The component is already `'use client'`, so the expanded state is a plain `useState`. The control follows `components/AccountList.tsx`: a button that names how many are hidden, flips its label when expanded, and carries `aria-expanded`. Read that file for the idiom.

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/period-over-period-chart.test.tsx`:

```tsx
  const many = Array.from({ length: 13 }, (_, i) => ({
    category: `Cat ${i}`,
    current: 100 - i,
    previous: 50,
  }))

  // NOTE — the phone chart's category labels CANNOT be asserted in jsdom. Task 3 established why:
  // the shared beforeAll stub makes the legend measure 340px, so the phone chart's plot height
  // computes to 0 and its category ticks never render. Any `phone.innerHTML` assertion about
  // category names therefore passes whatever the code does. The cap is pinned instead by:
  //   - capCategories' own tests (Task 2), which own the arithmetic;
  //   - the control's label below, which names `data.length` and only exists when a fold happened;
  //   - the desktop assertion below, whose ticks DO render (they lay out along the width).
  // That the phone chart draws exactly seven bars is verified on the device, not here.
  it('leaves the desktop chart uncapped', () => {
    const { container } = render(
      <PeriodOverPeriodChart data={many} currentLabel="Sep" previousLabel="Aug" />
    )
    const desktop = container.querySelector('.md\\:block')!
    expect(desktop.innerHTML).toContain('Cat 12')
    expect(desktop.innerHTML).not.toContain('Other')
  })

  // This is the load-bearing cap assertion in jsdom. The control renders ONLY when capCategories
  // returned an `other`, and its label names the full count — so it fails if the cap is bypassed,
  // if the limit changes, or if `data.length` is read from the capped list by mistake.
  it('offers a control naming how many are hidden', () => {
    render(<PeriodOverPeriodChart data={many} currentLabel="Sep" previousLabel="Aug" />)
    expect(screen.getByRole('button', { name: 'Show all 13 categories' })).toBeTruthy()
  })

  it('expands to every category when the control is used', () => {
    const { container } = render(
      <PeriodOverPeriodChart data={many} currentLabel="Sep" previousLabel="Aug" />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Show all 13 categories' }))
    // Asserted on the control, not the phone chart's labels — see the NOTE above.
    expect(screen.getByRole('button', { name: 'Show fewer' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Show all/ })).toBeNull()
  })

  it('states its expanded state for assistive tech', () => {
    render(<PeriodOverPeriodChart data={many} currentLabel="Sep" previousLabel="Aug" />)
    const control = screen.getByRole('button', { name: 'Show all 13 categories' })
    expect(control.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(control)
    expect(screen.getByRole('button', { name: 'Show fewer' }).getAttribute('aria-expanded')).toBe('true')
  })

  // Six or fewer is already everything, so a control that reveals nothing must not appear.
  it('offers no control when nothing is hidden', () => {
    render(<PeriodOverPeriodChart data={many.slice(0, 6)} currentLabel="Sep" previousLabel="Aug" />)
    expect(screen.queryByRole('button', { name: /Show all/ })).toBeNull()
  })
```

Add `fireEvent` to the existing `@testing-library/react` import if it is not already there, and `capCategories` is not imported by the test — the component uses it.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run tests/unit/period-over-period-chart.test.tsx`
Expected: FAIL — the phone chart renders all 13 and there is no control.

- [ ] **Step 3: Implement it**

At the top of the component body:

```tsx
  const [expanded, setExpanded] = useState(false)
  // Phone only. The desktop chart has the width for every category and this stage does not change
  // it (spec §5: the cap is "below `md`").
  const { shown, other } = capCategories(data)
  const phoneRows = expanded || !other ? data : [...shown, other]
```

Change the phone chart's `data={data}` to `data={phoneRows}`, and its height to `Math.max(200, phoneRows.length * 56)`. Leave the desktop chart on `data={data}`.

Then, immediately after the phone chart's wrapping `</div>` and inside the fragment:

```tsx
      {other && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="mt-2 text-sm font-medium text-emerald hover:text-emerald-600 md:hidden"
        >
          {expanded ? 'Show fewer' : `Show all ${data.length} categories`}
        </button>
      )}
```

Add `useState` to the React import and `capCategories` to the `@/lib/trends` import.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run tests/unit/period-over-period-chart.test.tsx && npx vitest run && npx tsc --noEmit && npm run lint && npm run build`
Expected: all clean.

- [ ] **Step 5: Check the tests bite**

Mutate and confirm each is caught, restoring after every one:

- pass `data` instead of `phoneRows` to the phone chart → **expect this NOT to be caught**, for the
  reason in the NOTE above; confirm that is so and say it plainly rather than inventing an
  assertion that appears to cover it. If you can find an honest jsdom assertion that does catch it,
  add it and say what it is.
- pass `phoneRows` to the desktop chart → the uncapped test must fail
- drop `md:hidden` from the button → nothing may catch it; if so, add an assertion pinning that class and confirm it then fails
- drop `aria-expanded` → the assistive-tech test must fail

Record all four results.

- [ ] **Step 6: Commit**

```bash
git add components/PeriodOverPeriodChart.tsx tests/unit/period-over-period-chart.test.tsx
git commit -m "Cap the phone comparison chart at six categories plus Other"
```

---

## Finishing the stage

- [ ] **Full verification, fresh:**

```bash
npx vitest run && npx tsc --noEmit && npm run lint && npm run build && npm run check:invariants
```

Report the actual numbers, not "should pass".

- [ ] **Confirm the failing grey is gone as a VALUE:** `grep -rn "'#c9cec7'" components/ lib/ app/ tests/` must return nothing. The bare hex still appears as prose in `lib/chart-palette.ts`'s comment, in this plan and in the spec — all three name it deliberately, as the thing that was replaced.

- [ ] **Desktop diff check.** Load `/trends` at desktop width. The comparison chart is still vertical, still every category, same height and axes — the only visible difference is that the "prior" series is now blue rather than pale grey. Anything else is a Global Constraint violation.

- [ ] **Ask the owner to check on their actual phone** via the PR's Vercel preview, and name three things and no more:
  1. The comparison chart reads left-to-right with category names down the side — no rotated, overlapping labels.
  2. Six categories plus "Other", with a control that expands to all of them.
  3. The two series are clearly distinguishable from each other.

  Say plainly whether the preview has rebuilt since the last push.

- [ ] **Anything found that does not belong in this branch becomes an issue**, per `.claude/rules/filing-issues.md`. #95 in particular is explicitly out of scope (§5.2) — do not start it.
