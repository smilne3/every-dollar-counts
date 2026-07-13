import { describe, it, expect } from 'vitest'
import { spendByCategory, progress, spendThisVsLast, monthKey } from '@/lib/budget'

const t = (amount: number, date: string, pfc: string, override: string | null = null) => ({
  amount,
  date,
  pfc_primary: pfc,
  user_category: override,
})

describe('spendByCategory', () => {
  it('sums outflows per effective category', () => {
    const r = spendByCategory([
      t(12, '2026-07-10', 'FOOD_AND_DRINK'),
      t(4.33, '2026-07-10', 'FOOD_AND_DRINK'),
      t(5.4, '2026-07-13', 'TRANSPORTATION'),
    ])
    expect(r.FOOD_AND_DRINK).toBeCloseTo(16.33)
    expect(r.TRANSPORTATION).toBeCloseTo(5.4)
  })

  it('ignores inflows (amount <= 0) and income/transfers', () => {
    const r = spendByCategory([
      t(-500, '2026-07-11', 'INCOME'),
      t(1000, '2026-07-12', 'TRANSFER_OUT'),
      t(20, '2026-07-12', 'ENTERTAINMENT'),
    ])
    expect(r.INCOME).toBeUndefined()
    expect(r.TRANSFER_OUT).toBeUndefined()
    expect(r.ENTERTAINMENT).toBe(20)
  })

  it('honors a user re-categorization', () => {
    const r = spendByCategory([t(12, '2026-07-10', 'FOOD_AND_DRINK', 'ENTERTAINMENT')])
    expect(r.ENTERTAINMENT).toBe(12)
    expect(r.FOOD_AND_DRINK).toBeUndefined()
  })
})

describe('progress', () => {
  it('clamps ratio to [0,1] and flags over-budget', () => {
    expect(progress(50, 100)).toEqual({ ratio: 0.5, over: false })
    expect(progress(150, 100)).toEqual({ ratio: 1, over: true })
    expect(progress(10, 0)).toEqual({ ratio: 0, over: true })
  })
})

describe('spendThisVsLast', () => {
  it('buckets by month', () => {
    const r = spendThisVsLast(
      [t(10, '2026-07-05', 'FOOD_AND_DRINK'), t(30, '2026-06-20', 'FOOD_AND_DRINK')],
      '2026-07',
      '2026-06'
    )
    expect(r.thisMonth.FOOD_AND_DRINK).toBe(10)
    expect(r.lastMonth.FOOD_AND_DRINK).toBe(30)
  })
})

describe('monthKey', () => {
  it('extracts YYYY-MM', () => expect(monthKey('2026-07-13')).toBe('2026-07'))
})
