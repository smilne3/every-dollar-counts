import { describe, it, expect } from 'vitest'
import {
  spendByCategory,
  budgetedSpend,
  progress,
  monthKey,
  inRange,
  lastCompleteMonths,
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

describe('lastCompleteMonths', () => {
  // 2 September 2026 — the date in #67's screenshot.
  const w = lastCompleteMonths(new Date(2026, 8, 2))

  it('reports the last month that has actually finished', () => {
    expect(w.current).toEqual({ from: '2026-08-01', to: '2026-08-31' })
  })

  it('compares it against the month before that', () => {
    expect(w.previous).toEqual({ from: '2026-07-01', to: '2026-07-31' })
  })

  // A month is complete when it has ended, not when it is nearly over — otherwise the page would
  // flip to a still-settling month on its last day, which is the shape of bug #67 was about.
  it('does not treat the current month as complete on its last day', () => {
    expect(lastCompleteMonths(new Date(2026, 8, 30)).current).toEqual({
      from: '2026-08-01',
      to: '2026-08-31',
    })
  })

  it('knows how long February is', () => {
    expect(lastCompleteMonths(new Date(2024, 2, 10)).current.to).toBe('2024-02-29') // leap
    expect(lastCompleteMonths(new Date(2026, 2, 10)).current.to).toBe('2026-02-28')
  })

  it('crosses a year boundary correctly', () => {
    const jan = lastCompleteMonths(new Date(2026, 0, 5))
    expect(jan.current).toEqual({ from: '2025-12-01', to: '2025-12-31' })
    expect(jan.previous).toEqual({ from: '2025-11-01', to: '2025-11-30' })
  })

  // An invalid Date would stringify to 'NaN-NaN-NaN' — String(NaN).padStart(2,'0') is 'NaN', so
  // padding does not catch it — and go to Postgres as a date filter. Fail where it is legible.
  it('refuses an invalid date instead of building a NaN window', () => {
    expect(() => lastCompleteMonths(new Date('nonsense'))).toThrow(/invalid Date/)
  })

  const everyDay = (fn: (now: Date) => string | null): string[] => {
    const bad: string[] = []
    const stop = new Date(2031, 0, 1)
    for (const d = new Date(2024, 0, 1); d < stop; d.setDate(d.getDate() + 1)) {
      const complaint = fn(new Date(d))
      if (complaint) bad.push(complaint)
    }
    return bad
  }

  it('always stays contiguous, non-overlapping, and behind today', () => {
    const nextDay = (s: string) => {
      const d = new Date(`${s}T00:00:00Z`)
      d.setUTCDate(d.getUTCDate() + 1)
      return d.toISOString().slice(0, 10)
    }
    const bad = everyDay((now) => {
      const { current, previous } = lastCompleteMonths(now)
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
        now.getDate()
      ).padStart(2, '0')}`
      if (nextDay(previous.to) !== current.from) return `${today}: not contiguous`
      if (!(current.to < today)) return `${today}: current window is not finished`
      if (current.from.slice(8) !== '01' || previous.from.slice(8) !== '01') {
        return `${today}: a window does not start on the 1st`
      }
      return null
    })
    expect(bad).toEqual([])
  })

  // Why calendar months and not a rolling month: a monthly bill is monthly BY CALENDAR MONTH, so
  // each window holds exactly one of it however the posting date moves inside that month. A
  // rolling window cannot promise this — measured against the real mortgage it doubled it into
  // one window and left the other empty ($7,858.70 against $0.00) on 2 September 2026.
  //
  // Stated precisely, because the broader claim is false: this holds for a bill that posts WITHIN
  // its own calendar month. See the limitation test below for the case it does not cover.
  const postings = (dueDay: number, shift: number) => {
    const out = new Set<string>()
    for (let y = 2023; y <= 2031; y++) {
      for (let m = 0; m < 12; m++) {
        const lastOfMonth = new Date(y, m + 1, 0).getDate()
        const d = new Date(y, m, Math.min(dueDay, lastOfMonth))
        while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + shift)
        out.add(
          `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
            d.getDate()
          ).padStart(2, '0')}`
        )
      }
    }
    return out
  }
  const held = (posts: Set<string>, w: DateWindow) =>
    [...posts].filter((p) => p >= w.from && p <= w.to).length

  it.each([
    ['due the 1st, postponed to Monday — the household mortgage', 1, 1],
    ['due mid-month', 15, 1],
    ['due the 31st, brought forward to Friday', 31, -1],
  ])('holds exactly one occurrence of a bill %s', (_label, dueDay, shift) => {
    const posts = postings(dueDay, shift)
    const bad = everyDay((now) => {
      const { current, previous } = lastCompleteMonths(now)
      return held(posts, current) === 1 && held(posts, previous) === 1 ? null : 'x'
    })
    expect(bad).toEqual([])
  })

  // The limitation, as a test rather than as prose. A bill whose posting crosses a month boundary
  // — 31 August falling on a Sunday and paying on 1 September — belongs to August but lands in
  // September, so no window keyed on calendar months can count it once. Knowing a payment is one
  // recurring commitment rather than a dated row is #64's job, not this window's.
  it('is still fooled by a bill that posts outside its own calendar month', () => {
    const posts = postings(31, 1)
    const bad = everyDay((now) => {
      const { current, previous } = lastCompleteMonths(now)
      return held(posts, current) === 1 && held(posts, previous) === 1 ? null : 'x'
    })
    expect(bad.length).toBeGreaterThan(0)
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
