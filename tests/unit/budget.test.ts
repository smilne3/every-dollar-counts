import { describe, it, expect } from 'vitest'
import {
  spendByCategory,
  budgetedSpend,
  progress,
  monthKey,
  inRange,
  rollingMonths,
} from '@/lib/budget'
import type { SpendContext } from '@/lib/spend-context'

const pfcMap: Record<string, string> = {
  FOOD_AND_DRINK: 'Food & Drink',
  TRANSPORTATION: 'Transportation',
  INCOME: 'Income',
  TRANSFER_OUT: 'Transfer Out',
  ENTERTAINMENT: 'Entertainment',
}
const nonSpending = new Set(['Income', 'Transfer In', 'Transfer Out'])

// A context with no reimbursables — the baseline every pre-existing test uses. These tests passing
// unchanged is the proof that an empty split map is a no-op.
const ctx = (
  over: Partial<SpendContext> = {},
  map: Record<string, string> = pfcMap
): SpendContext => ({
  pfcMap: map,
  nonSpending,
  transfers: new Set(['Transfer In', 'Transfer Out']),
  reimbursedByTxn: {},
  ...over,
})

let seq = 0
const t = (
  amount: number,
  date: string,
  pfc: string,
  override: string | null = null,
  pfc_detailed: string | null = null,
  id: string = `t${++seq}`
) => ({
  id,
  amount,
  date,
  pfc_primary: pfc,
  pfc_detailed,
  user_category: override,
  reimbursable_amount: null,
})

describe('spendByCategory', () => {
  it('sums outflows per effective category name', () => {
    const r = spendByCategory(
      [
        t(12, '2026-07-10', 'FOOD_AND_DRINK'),
        t(4.33, '2026-07-10', 'FOOD_AND_DRINK'),
        t(5.4, '2026-07-13', 'TRANSPORTATION'),
      ],
      ctx()
    )
    expect(r['Food & Drink']).toBeCloseTo(16.33)
    expect(r['Transportation']).toBeCloseTo(5.4)
  })

  // Credit-card payments are internal transfers (paying off already-counted purchases). They carry
  // pfc_primary=LOAN_PAYMENTS, so the name-based exclusion misses them; they must be excluded by
  // detailed category. A mortgage payment, by contrast, is real spending and stays.
  it('excludes credit-card payments but keeps genuine loan payments', () => {
    const r = spendByCategory(
      [
        t(8930.72, '2026-07-10', 'LOAN_PAYMENTS', null, 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT'),
        t(493.75, '2026-07-11', 'LOAN_PAYMENTS', null, 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT'),
        t(3929.35, '2026-07-01', 'LOAN_PAYMENTS', null, 'LOAN_PAYMENTS_MORTGAGE_PAYMENT'),
      ],
      ctx({}, { ...pfcMap, LOAN_PAYMENTS: 'Loan Payments' })
    )
    // only the mortgage remains under Loan Payments; the two card payments are gone
    expect(r['Loan Payments']).toBeCloseTo(3929.35)
  })

  // A refund (inflow in a spending category) must NET DOWN that category, not be ignored.
  it('nets refunds against their spending category', () => {
    const r = spendByCategory(
      [
        t(800, '2026-07-04', 'TRAVEL'),
        t(-500, '2026-07-20', 'TRAVEL'), // refund
      ],
      ctx({}, { ...pfcMap, TRAVEL: 'Travel' })
    )
    expect(r['Travel']).toBeCloseTo(300)
  })

  it('ignores inflows and income/transfers', () => {
    const r = spendByCategory(
      [
        t(-500, '2026-07-11', 'INCOME'),
        t(1000, '2026-07-12', 'TRANSFER_OUT'),
        t(20, '2026-07-12', 'ENTERTAINMENT'),
      ],
      ctx()
    )
    expect(r['Income']).toBeUndefined()
    expect(r['Transfer Out']).toBeUndefined()
    expect(r['Entertainment']).toBe(20)
  })

  it('honors a user re-categorization (by name)', () => {
    const r = spendByCategory(
      [t(12, '2026-07-10', 'FOOD_AND_DRINK', 'Entertainment')],
      ctx()
    )
    expect(r['Entertainment']).toBe(12)
    expect(r['Food & Drink']).toBeUndefined()
  })

  // #27: the $1,000 rental split three ways. Only the unsplit $250 is the user's spending.
  it('counts only the unsplit remainder of a reimbursable outflow', () => {
    const rental = t(1000, '2026-07-04', 'TRAVEL', null, null, 'rental')
    const r = spendByCategory(
      [rental],
      ctx({ reimbursedByTxn: { rental: 750 } }, { ...pfcMap, TRAVEL: 'Travel' })
    )
    expect(r['Travel']).toBeCloseTo(250)
  })

  // A repayment tagged to a claim is flow-neutral: it must NOT net the category down like a refund.
  it('ignores a fully tagged repayment inflow', () => {
    const rental = t(1000, '2026-07-04', 'TRAVEL', null, null, 'rental')
    const repay = t(-250, '2026-08-03', 'TRAVEL', null, null, 'repay')
    const r = spendByCategory(
      [rental, repay],
      ctx({ reimbursedByTxn: { rental: 750, repay: 250 } }, { ...pfcMap, TRAVEL: 'Travel' })
    )
    // 250 of real spending, and the repayment contributes nothing at all.
    expect(r['Travel']).toBeCloseTo(250)
  })

  // A written-off claim arrives as a synthesised transaction in its allocated category.
  it('counts a write-off as spending in its allocated category', () => {
    const r = spendByCategory(
      [
        {
          id: 'writeoff:c1:0',
          amount: 540,
          date: '2026-11-03',
          user_category: 'Food & Drink',
          pfc_primary: null,
          pfc_detailed: null,
          reimbursable_amount: null,
        },
      ],
      ctx()
    )
    expect(r['Food & Drink']).toBeCloseTo(540)
  })
})

describe('progress', () => {
  it('clamps ratio to [0,1] and flags over-budget', () => {
    expect(progress(50, 100)).toEqual({ ratio: 0.5, over: false })
    expect(progress(150, 100)).toEqual({ ratio: 1, over: true })
    expect(progress(10, 0)).toEqual({ ratio: 0, over: true })
  })
})

describe('inRange', () => {
  const rows = [
    t(1, '2026-08-03', 'FOOD_AND_DRINK'),
    t(2, '2026-08-04', 'FOOD_AND_DRINK'),
    t(3, '2026-09-02', 'FOOD_AND_DRINK'),
    t(4, '2026-09-03', 'FOOD_AND_DRINK'),
  ]

  // Both ends inclusive: a window described to the reader as "Aug 4 - Sep 2" must contain the
  // spending of Aug 4 and of Sep 2, or the label on the card is a lie.
  it('includes both endpoints', () => {
    expect(inRange(rows, '2026-08-04', '2026-09-02').map((r) => r.amount)).toEqual([2, 3])
  })

  it('is empty when nothing falls inside', () => {
    expect(inRange(rows, '2026-07-01', '2026-07-31')).toEqual([])
  })

  // The old query had a .gte and no upper bound, so a future-dated row counted as "this month".
  it('excludes rows after the window, not just before it', () => {
    expect(inRange(rows, '2026-08-01', '2026-09-02').some((r) => r.date === '2026-09-03')).toBe(
      false
    )
  })
})

describe('rollingMonths', () => {
  // 2 September 2026 — the date in #67's screenshot, when the calendar month held two categories.
  const w = rollingMonths(new Date(2026, 8, 2))

  it('ends the current window today and opens it the day after a month ago', () => {
    expect(w.current).toEqual({ from: '2026-08-03', to: '2026-09-02' })
  })

  it('puts the previous window immediately before it, with no gap and no overlap', () => {
    expect(w.previous).toEqual({ from: '2026-07-03', to: '2026-08-02' })
  })

  it('clamps to the shorter month rather than inventing a date', () => {
    // 31 March minus one month is 28 February, not 31 February. The window then happens to be
    // the whole of March, and the previous window the whole of February — which is correct.
    const march = rollingMonths(new Date(2026, 2, 31))
    expect(march.current).toEqual({ from: '2026-03-01', to: '2026-03-31' })
    expect(march.previous).toEqual({ from: '2026-02-01', to: '2026-02-28' })
  })

  it('crosses a year boundary correctly', () => {
    const jan = rollingMonths(new Date(2026, 0, 5))
    expect(jan.current).toEqual({ from: '2025-12-06', to: '2026-01-05' })
    expect(jan.previous).toEqual({ from: '2025-11-06', to: '2025-12-05' })
  })

  // The property the whole comparison rests on, and the reason a fixed 30-day window was wrong:
  // 30 days is shorter than 11 months of 12, so such a window drifts backwards through the
  // calendar and periodically holds two 1st-of-month bills, or none. With this household's
  // $3,929.35 mortgage that reads as "$7,858.70 vs $0.00" — a louder lie than the bug in #67.
  //
  // Checked every day for seven years rather than at one flattering date.
  const everyDay = (fn: (now: Date) => string | null): string[] => {
    const bad: string[] = []
    for (let i = 0; i < 365 * 7; i++) {
      const complaint = fn(new Date(2024, 0, 1 + i))
      if (complaint) bad.push(complaint)
    }
    return bad
  }

  const firstsIn = (from: string, to: string): number => {
    let n = 0
    const d = new Date(`${from}T00:00:00Z`)
    while (d.toISOString().slice(0, 10) <= to) {
      if (d.getUTCDate() === 1) n++
      d.setUTCDate(d.getUTCDate() + 1)
    }
    return n
  }

  it('always gives each window exactly one occurrence of a monthly bill', () => {
    const bad = everyDay((now) => {
      const { current, previous } = rollingMonths(now)
      const c = firstsIn(current.from, current.to)
      const p = firstsIn(previous.from, previous.to)
      return c === 1 && p === 1 ? null : `${current.to}: current has ${c}, previous has ${p}`
    })
    expect(bad).toEqual([])
  })

  it('always stays contiguous, non-overlapping, and ending today', () => {
    const nextDay = (s: string) => {
      const d = new Date(`${s}T00:00:00Z`)
      d.setUTCDate(d.getUTCDate() + 1)
      return d.toISOString().slice(0, 10)
    }
    const bad = everyDay((now) => {
      const { current, previous } = rollingMonths(now)
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
        now.getDate()
      ).padStart(2, '0')}`
      if (current.to !== today) return `${today}: current ends ${current.to}`
      if (nextDay(previous.to) !== current.from) {
        return `${today}: ${previous.to} -> ${current.from} is not contiguous`
      }
      return null
    })
    expect(bad).toEqual([])
  })
})

describe('monthKey', () => {
  it('extracts YYYY-MM', () => expect(monthKey('2026-07-13')).toBe('2026-07'))
})

describe('budgetedSpend', () => {
  it('counts only categories that have a limit set', () => {
    const spend = { 'Food & Drink': 16.33, Shopping: 89.4, 'Personal Care': 78.5 }
    // Budgeting one category must not drag the other categories' spend into the total.
    expect(budgetedSpend(spend, { 'Food & Drink': 200 })).toBe(16.33)
    expect(budgetedSpend(spend, { 'Food & Drink': 200, Shopping: 100 })).toBeCloseTo(105.73)
  })

  it('treats a budgeted category with no spend as zero', () => {
    expect(budgetedSpend({ Shopping: 50 }, { Travel: 300 })).toBe(0)
  })

  it('is zero when nothing is budgeted', () => {
    expect(budgetedSpend({ Shopping: 50 }, {})).toBe(0)
  })
})
