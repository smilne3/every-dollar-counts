import { spendByCategory, inRange, type DateWindow, type Txn } from './budget'
import { sortedSpendRows } from './breakdown'
import { monthLabel } from './format'
import type { SpendContext } from './spend-context'

// Everything the Trends page renders, derived in one place so it can be tested without rendering
// an async Server Component. The page is then only a query and some JSX.
//
// Each card's rows travel WITH the label that describes them. #67 was a page that showed one
// window under a heading naming another; keeping the pair together is what stops that shape of
// bug returning through a mis-wired prop.
export type TrendsView = {
  spend: {
    rows: { category: string; amount: number }[]
    label: string // 'Aug 2026'
  }
  compare: {
    rows: { category: string; current: number; previous: number }[]
    label: string // 'Aug 2026 vs Jul 2026'
    currentLabel: string
    previousLabel: string
  }
}

const cents = (n: number) => Math.round(n * 100) / 100

export function trendsView(
  windows: { current: DateWindow; previous: DateWindow },
  txns: Txn[],
  ctx: SpendContext
): TrendsView {
  const { current, previous } = windows
  const currentLabel = monthLabel(current.from)
  const previousLabel = monthLabel(previous.from)

  // spendByCategory carries the exclusions the rest of the app uses — credit-card payments (#31),
  // transfers and income, reimbursable remainders (#27) — so both windows inherit them by
  // construction rather than by remembering to.
  const currentByCat = spendByCategory(inRange(txns, current), ctx)
  const previousByCat = spendByCategory(inRange(txns, previous), ctx)

  // A category present in only one window still belongs on the comparison, at zero for the other.
  const names = Array.from(new Set([...Object.keys(currentByCat), ...Object.keys(previousByCat)]))

  return {
    spend: {
      rows: sortedSpendRows(currentByCat),
      label: currentLabel,
    },
    compare: {
      // Rounded here rather than in the chart: it keeps the component a pure pass-through with
      // no row mapping of its own to get backwards, and puts the arithmetic somewhere testable.
      rows: names
        .map((category) => ({
          category,
          current: cents(currentByCat[category] ?? 0),
          previous: cents(previousByCat[category] ?? 0),
        }))
        .sort((a, b) => b.current + b.previous - (a.current + a.previous)),
      label: `${currentLabel} vs ${previousLabel}`,
      currentLabel,
      previousLabel,
    },
  }
}

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
