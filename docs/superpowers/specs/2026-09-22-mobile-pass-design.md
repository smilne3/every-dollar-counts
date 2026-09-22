# The Phone Is the Primary Device — Design Spec

- **Repo:** `smilne3/every-dollar-counts`
- **Date:** 2026-09-22
- **Related:** #95 (trends change-view toggle, additive and later)
- **Status:** Proposed design, awaiting owner review
- **One line:** Every page gains a layout that works below `md`, because the household uses this app on phones and four of its nine pages have no phone handling at all — while the desktop table layouts stay exactly as they are.

---

## 1. Why this exists

The household's own words: *"the UI is horrible on phone (where we primarily use)."* That is the whole justification, but it is worth recording what "horrible" is made of, because three of the four defects are measurable and one of them was already fixed once and has since broken again.

### 1.1 The shell is fine. The pages are not.

`components/AppShell.tsx` does real mobile work already — the sidebar is `hidden … md:flex`, there is a `md:hidden` sticky header, and the bottom tab bar carries `pb-[env(safe-area-inset-bottom)]` for the home indicator. Navigation is not the problem and is not in scope.

The page content is. Responsive rules per page:

| Page | `sm:` / `md:` / `lg:` rules |
|---|---|
| trends | 8 |
| dashboard | 5 |
| transactions | 1 |
| **budgets** | **0** |
| **goals** | **0** |
| **reimbursements** | **0** |
| **settings** | **0** |

Four pages were written desktop-first and never revisited.

### 1.2 The transactions table needs 800px and gets 390

`app/(app)/transactions/page.tsx:215-221` declares six fixed columns:

```
w-32 (128) + w-52 (208) + auto + w-40 (160) + w-36 (144) + w-20 (80)
= ~720px of fixed width, before the auto Category column
```

The table is `w-full table-fixed` inside an `overflow-x-auto` wrapper. **That combination is the defect.** `w-full` instructs the table never to exceed its container, so the horizontal scroll never engages. Instead the columns compress to roughly 40% of their declared widths, and content that cannot shrink — the `whitespace-nowrap` amount, the category pill — overflows its cell. No cell sets `overflow-hidden`, so nothing clips: the amount is simply painted on top of the category.

This is what the household reported as the numbers being unreadable. It is a layout defect, not a formatting one.

### 1.3 The net worth tile is clipped, and this is the second time

`components/ui/StatCard.tsx:21` already carries the scar:

```
Scaled down on small screens: a figure like -$40,452.32 overflows the tile in
the 2-column mobile grid at anything above text-xl.
```

That fix — dropping to `text-xl` on mobile — held for an 11-character figure. The household's net worth is now **$1,182,885.15**, which is 13.

The space available, at a 390px viewport:

```
390 − 32 (main px-4) = 358
(358 − 16 gap) / 2   = 171 per tile      (dashboard/page.tsx:236, grid-cols-2)
171 − 40 (Card p-5)  = 131px of content
```

`$1,182,885.15` at `text-xl` with `tabular-nums` needs roughly 138px. It is about 7px too wide — the margin that looks fine right up until a net worth crosses into seven figures. The other three tiles ($34,920.18, $8,775.73, $5,448.99) fit.

**Shrinking the type again is not the fix.** It is the move that already failed once, and it fails in the direction of making the most important number on the app's most-opened screen the hardest to read.

### 1.4 The comparison chart is the wrong shape, and half of it is invisible

`components/PeriodOverPeriodChart.tsx:35-42` is a **vertical** grouped bar chart with `angle={-40}`, `interval={0}` and `height={70}` on the x-axis — every category label forced, every one rotated.

The household has 13 spending categories. At 390px the plot area is roughly 273px after page padding, chart margins and the y-axis. That is 26 bars in 273px — about 10px each — under 13 overlapping rotated labels, one of which is "Government & Nonprofit".

Separately, the colours fail measurement. Running the palette validator on the pair the component ships (`#0e9f6e` + `#c9cec7`):

```
[FAIL] Lightness band    #c9cec7 at 0.846 — outside the 0.43–0.77 band
[FAIL] Chroma floor      #c9cec7 at 0.011 — reads as grey
[WARN] Contrast          #c9cec7 at 1.56:1 against the surface
```

The prior-period bars are very nearly invisible, which is worse on a phone held outdoors than on the desk where they were chosen.

**Success looks like:** every page is usable one-handed at 390px, no number is clipped or overlapped, and the desktop layouts are untouched apart from the chart palette (§5.1).

---

## 2. The strategy: add, don't replace

**Desktop layouts stay exactly as they are.** Below `md` each surface gets a second presentation; at `md` and above the existing markup renders untouched.

```
        < md  (phone)                   >= md  (unchanged)
        ─────────────────               ──────────────────
        stacked cards, sheets           the six-column table
        hero + compact tiles            the 2x2 / 4-across grid
        horizontal bars                 the existing charts
```

`md` is the boundary because `AppShell` already switches there — the sidebar appears, the bottom tab bar disappears. Introducing a second breakpoint for content would put the page and its chrome out of step.

**Why not phone-first with desktop adapting?** It halves the markup and removes the risk of the two drifting. It was rejected because the household uses the desktop table to scan many transactions at once, and a stacked card list is materially worse at that job. The cost of this decision is real and is accepted: **a row's presentation exists twice, and a change to one must be made to the other.** Section 9 says how that is contained.

---

## 3. Transactions — the row becomes a card, the controls move to a sheet

The most-used screen and the only one where content currently overlaps.

### 3.1 The list

Below `md`, the table is replaced by a list of rows. Each row shows **merchant, amount, and a muted `date · category` line** — nothing else:

```
┌──────────────────────────────────┐
│ WF HOME MTG            −$3,929.35│
│ Sep 1 · Loan Payments            │
├──────────────────────────────────┤
│ Walmart                   +$13.73│
│ Sep 1 · Shopping                 │
└──────────────────────────────────┘
```

Amount keeps the existing sign convention (`display = -t.amount`, `TransactionRow.tsx:33`) and the existing colour rule: outflow in `text-ink`, inflow in `text-emerald`, credit-card payment in `text-muted`.

**A row carrying a reimbursable mark shows it on the meta line** — `Sep 1 · Shopping · your share $8.20`. Without this the mark is invisible until the row is opened, which would make "what have I already marked?" a question answerable only by tapping every row in turn.

### 3.2 The sheet

Tapping a row opens a sheet containing the category picker and the reimbursable controls. **The sheet is the reason this layout was chosen over the alternatives.**

The reason is room, not control quality. `CategoryPicker` is already a native `<select>` (`CategoryPicker.tsx:44`) carrying an `aria-label`, and iOS renders that as a full-screen wheel — on its own it is good on a phone. What fails is that a 390px row has nowhere to put a select, a checkbox, an editor trigger *and* an amount at the same time. `Dialog`'s own comment records the second half of the problem: the table sits in `overflow-x-auto` inside a Card with `overflow-hidden`, so an anchored panel is clipped by two ancestors, "worst on the narrow screens that need it most."

**The sheet therefore reuses `CategoryPicker`, `ReimbursableCheckbox` and `ReimbursableEditor` unchanged**, and is built on the existing `Dialog`. No phone-specific variant of any control is written; the sheet is a container that gives the three existing ones somewhere to live.

The reimbursable checkbox and the partial editor move into the same sheet, which also resolves the problem that a compact row has nowhere to put them.

**Card payments keep their existing exemption.** `isCreditCardPayment` already suppresses the category picker, the checkbox and the editor on the desktop row, for the reason documented at `TransactionRow.tsx:48-58`: setting `user_category` on a card payment re-enters both legs into the totals, and on a real $7,866.69 payment that moved September spending from $3,949.16 to *minus* $3,917.53. The sheet must honour the same predicate and show "Card payment · moves between your accounts" with no controls. **This is the single most important correctness constraint in this spec.**

### 3.3 Why not the alternatives

- **Two-line row with an inline category pill** — denser, and no extra tap to categorise. Rejected because the reimbursable mark then has nowhere to live except a swipe or long-press, i.e. a gesture with no visual affordance that the user has to be told about.
- **Grouped by date, everything on the row** — nothing hidden, no extra tap. Rejected on density: roughly four rows per screen against eight, which makes reviewing a month of 90 transactions a long scroll.

---

## 4. Dashboard — net worth leads

Below `md` the four-tile grid becomes a hero plus a row of three:

```
┌──────────────────────────────────┐
│ NET WORTH                        │
│ $1,182,885.15                    │   full width, larger than today
└──────────────────────────────────┘
┌──────────┬──────────┬────────────┐
│ CASH     │ SPENT    │ SAVED      │
│ $34,920  │ $8,776   │ $5,449     │   whole dollars
└──────────┴──────────┴────────────┘
```

Net worth renders **exact and full width**, so §1.3 cannot recur no matter how large the figure grows. The other three round to whole dollars, which is sufficient for a glance and buys the width to fit three across.

Mechanically this means **`StatCard` gains a variant** — `hero` (exact, full width) and `compact` (rounded) — rather than each caller hand-rolling its own type sizes. That is what makes the §9 formatting test possible to write, and it keeps the rounding rule in one place instead of four.

This treats the tiles by importance rather than equally, which matches the stated phone task: open it, see where things stand, close it.

**Rounding is display-only.** It happens in the tile, never in the value passed to it, and never on the desktop layout.

The remaining dashboard sections stack in the order they already have: the spend/income chart, recent activity, then accounts. The account card list is long — 12 today — so below `md` it shows the first 4 behind a **"Show all N"** control, N being whatever the household actually has. Accounts are reference material rather than the reason the page was opened.

---

## 5. Trends — rotate the chart that doesn't work into the shape of the one that does

`SpendByCategoryChart` is already horizontal and already works on a phone. `PeriodOverPeriodChart` is vertical and does not. Below `md`, the comparison chart becomes horizontal:

```
Loan Payments                 $3,929
████████████████████████████████████  last 30 days
████████████████████████████████████  prior 30 days

Food & Drink                  $2,314
█████████████████████
████████████████████████████████
```

Horizontal bars need no rotated labels at all, which removes the §1.4 collision by construction rather than by tuning font sizes.

**Categories are capped at the top 6 plus a tappable "Other" below `md`.** The household's bottom 7 categories total $665 of $11,600 — about 6% — so the chart fits one screen while hiding very little. Tapping "Other" expands the remainder.

### 5.1 The palette changes on both layouts

`#c9cec7` is replaced by **`#0369a1`**. Paired with the existing `#0e9f6e` it passes all six checks in light mode and holds in dark mode with a single contrast WARN (2.94:1) that the direct amount labels discharge.

This is the one change in this spec that is **not** phone-only. A series at 1.56:1 contrast is not a mobile defect; it is a defect that mobile made obvious. Applying it below `md` alone would leave the desktop chart failing the same check for no reason.

### 5.2 Out of scope here

A "what changed" view is filed as **#95** and is deliberately not in this spec. It is additive, and it has a blind spot — Loan Payments is $3,929.35 in both windows, so its delta is $0 and it would not render at all — which is why it must be a toggle on top of this chart rather than a replacement for it.

---

## 6. Reimbursements — two tables, the same treatment

Two `<table>` layouts and zero breakpoints, so it is the second-worst page after transactions.

Both tables become the §3.1 card list below `md`. The reimbursements page is about amounts owed rather than categorisation, so rows expose the **amount, who owes it, and the outstanding balance**; the editor opens in the same style of sheet as §3.2 rather than inline.

No new interaction model is introduced here. If §3 is right, this page is an application of it.

---

## 7. Budgets, goals, settings, breakdown — stop assuming width

These four need no new interaction model, only layouts that do not assume a wide viewport.

- **Budgets** — `BudgetEditor` gets one budget row per line below `md`: category, a full-width progress bar, and amount-spent / amount-budgeted beneath it. Any side-by-side label/input/bar arrangement stacks.
- **Goals** — `GoalsList` is already a list; it needs its rows to stack and its progress bars to go full width.
- **Settings** — four cards (`CategoryManager`, `InvitePartnerForm`, `HomeValueCard`, `TimezoneCard`) stack to one column. Every form control goes full width with a minimum 44px tap height. `CategoryManager` with 18 categories needs its rename/delete controls reachable without horizontal scroll.
- **Breakdown** — `breakdown/[metric]` lists rows with amounts; same card treatment as §3.1, no sheet since there is nothing to edit.

---

## 8. Sequencing

Ordered by severity, and each stage ships independently:

1. **Transactions** — the only page where content overlaps, and the most used
2. **Dashboard tiles** — the clipped headline number, small and self-contained
3. **Reimbursements** — applies §3 to two more tables
4. **Trends** — chart rotation, plus the palette fix on both layouts
5. **Budgets, goals, settings, breakdown** — the layout-only pages

Stage 2 is deliberately early despite being small: it is one number on the screen the household opens most, and it does not depend on stage 1.

---

## 9. Testing

The existing suite is 338 tests and **none of them cover layout**, which is why §1.3 regressed after being fixed. Layout assertions in jsdom are largely theatre — it does not do layout — so the tests here target the things that are actually decidable:

- **`StatCard` renders the exact value in the hero slot and a rounded value in a compact slot.** This is a formatting assertion, not a width one, and it is the assertion that would have caught §1.3 regressing had the tile been given a variant.
- **The phone row and the desktop row derive from one source.** Both presentations must consume the same `effectiveCategory`, the same `display = -amount` convention, and the same `isCreditCardPayment` predicate. A test asserts the two render identical category, amount and card-payment state for the same transaction. **This is how §2's accepted duplication cost is contained** — the markup may differ, the meaning may not.
- **The sheet honours the card-payment exemption.** Given a `LOAN_PAYMENTS_CREDIT_CARD_PAYMENT` transaction with no `user_category`, the sheet offers no category picker, no checkbox and no editor. This guards the $7,866.69 failure documented at `TransactionRow.tsx:48-58`.
- **Trends caps at six categories plus Other below `md`, and Other's amount equals the sum of the remainder.** A pure function over the rows; no rendering required.
- **The palette stays validated.** A test asserting the chart constants are the validated pair, so a future colour change has to be deliberate.

Visual verification is manual, on a real phone, per stage. Neither jsdom nor a CI assertion will tell anyone whether a tap target is comfortable.

---

## 10. Explicitly not doing

- **Not changing any desktop layout**, with the single exception of the chart palette (§5.1), for the reason given there.
- **Not touching `AppShell`.** Navigation already works on a phone (§1.1).
- **Not changing any money calculation.** No file in `lib/` that computes spending, income, budgets or net worth is edited by this work. Rounding in §4 is display-only.
- **Not building the #95 change-view toggle.**
- **Not adding a component library or a CSS framework.** Tailwind plus the existing `components/ui` primitives are sufficient.
- **Not fixing #69** (unlimited transaction reads truncating at 1,000 rows). Real, live, and unrelated.

---

## 11. Rejected alternatives

**Phone-first with desktop adapting.** One layout per surface, designed at 390px, widening gracefully. Half the markup, no drift. Rejected because the desktop table is genuinely better for scanning many transactions and the household uses it for that.

**A minimum width on the table so `overflow-x-auto` engages.** Two lines: `min-w-[800px]` plus `overflow-hidden` on cells. It would stop the overlap today. Rejected as a destination rather than a stopgap — reading a row would mean swiping sideways to see the amount, on the app's most-used screen. It remains available as a one-hour patch if the full pass stalls.

**Abbreviating net worth to `$1.18M` with the exact figure on tap.** The smallest possible change; the 2×2 grid survives untouched. Rejected because the number the household opens the app to see should not be the one that is rounded.

**Shrinking the tile type again.** The move that already failed once (§1.3). Each seven-figure increment would require another reduction.
