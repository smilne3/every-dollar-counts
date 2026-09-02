import { describe, it, expect } from 'vitest'
import {
  spendByCategory,
  budgetedSpend,
  progress,
  monthKey,
  inRange,
  rollingMonths,
  type DateWindow,
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
    expect(inRange(rows, { from: '2026-08-04', to: '2026-09-02' }).map((r) => r.amount)).toEqual([
      2, 3,
    ])
  })

  it('is empty when nothing falls inside', () => {
    expect(inRange(rows, { from: '2026-07-01', to: '2026-07-31' })).toEqual([])
  })

  it('excludes rows after the window, not just before it', () => {
    expect(
      inRange(rows, { from: '2026-08-01', to: '2026-09-02' }).some((r) => r.date === '2026-09-03')
    ).toBe(false)
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

  // An invalid Date stringifies to 'NaN-NaN-NaN' — String(NaN).padStart(2,'0') is 'NaN', so the
  // padding does not catch it — and that string would go to Postgres as a date filter. The query
  // then errors, the page shows "no spending", and only the card's label looks broken. Fail here,
  // where the cause is legible, rather than three layers down as an empty chart.
  it('refuses an invalid date instead of building a NaN window', () => {
    expect(() => rollingMonths(new Date('nonsense'))).toThrow(/invalid Date/)
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

  // The property the comparison rests on, and the reason a fixed 30-day window was rejected: 30
  // days is no longer than eleven months of twelve, so such a window drifts backwards through the
  // calendar and periodically holds two 1st-of-month bills, or none. With this household's
  // $3,929.35 mortgage that reads as "$7,858.70 vs $0.00" — a louder lie than the bug in #67.
  //
  // Note what this does and does not cover: it is a claim about calendar DAYS, so it holds for a
  // bill on a fixed date and not for one that drifts. See the drifting-bill test below.
  //
  // Checked every day for seven years rather than at one flattering date.
  const everyDay = (fn: (now: Date) => string | null): string[] => {
    const bad: string[] = []
    const stop = new Date(2031, 0, 1)
    for (const d = new Date(2024, 0, 1); d < stop; d.setDate(d.getDate() + 1)) {
      const complaint = fn(new Date(d))
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

  it('always gives each window exactly one occurrence of a fixed-date monthly bill', () => {
    const bad = everyDay((now) => {
      const { current, previous } = rollingMonths(now)
      const c = firstsIn(current.from, current.to)
      const p = firstsIn(previous.from, previous.to)
      return c === 1 && p === 1 ? null : `${current.to}: current has ${c}, previous has ${p}`
    })
    expect(bad).toEqual([])
  })

  it('always stays contiguous and non-overlapping, ending today and starting a month back', () => {
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
      if (!(previous.from <= previous.to)) return `${today}: previous window is inverted`
      if (!(current.from <= current.to)) return `${today}: current window is inverted`
      return null
    })
    expect(bad).toEqual([])
  })

  // A real bill is not a fixed date. The mortgage is due on the 1st and posts on the 3rd when the
  // 1st is a Saturday — #67 records exactly that for August — and two postings 29 days apart can
  // both land in one month-long window. This test exists to stop the comments claiming otherwise:
  // anchoring makes the failure rarer than a fixed 30-day window does, not impossible.
  it('is still fooled by a bill that drifts off the 1st — just less often than 30 days', () => {
    const posted = new Set<string>()
    for (let y = 2024; y <= 2031; y++) {
      for (let m = 0; m < 12; m++) {
        const d = new Date(y, m, 1)
        while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1)
        posted.add(
          `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
            d.getDate()
          ).padStart(2, '0')}`
        )
      }
    }
    const held = (w: { from: string; to: string }) =>
      [...posted].filter((p) => p >= w.from && p <= w.to).length

    // The rejected alternative, inline, so the two are measured over identical days.
    const fixed30 = (now: Date) => {
      const back = (n: number) => {
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - n)
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
          d.getDate()
        ).padStart(2, '0')}`
      }
      return { current: { from: back(29), to: back(0) }, previous: { from: back(59), to: back(30) } }
    }

    const unevenDays = (windows: (now: Date) => { current: DateWindow; previous: DateWindow }) =>
      everyDay((now) => {
        const { current, previous } = windows(now)
        return held(current) === held(previous) ? null : 'x'
      }).length

    const anchored = unevenDays(rollingMonths)
    const thirty = unevenDays(fixed30)

    // The honest claim, and the only one worth asserting: anchoring is better, not perfect.
    // Measured over 2024-2030: 129 days of 2,557 against 190 — 5.0% versus 7.4%.
    expect(anchored).toBeLessThan(thirty)
    expect(anchored).toBeGreaterThan(0)
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
