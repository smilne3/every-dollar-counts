import { describe, it, expect } from 'vitest'
import { axisTick, shortDate, monthLabel } from '@/lib/format'

describe('axisTick', () => {
  it('keeps half-thousand gridlines honest', () => {
    // The regression: Math.round(v/1000) labelled these $0/$2k/$3k/$5k/$6k, so a bar
    // at 1500 sat on a line reading "$2k".
    expect([0, 1500, 3000, 4500, 6000].map(axisTick)).toEqual([
      '$0',
      '$1.5k',
      '$3k',
      '$4.5k',
      '$6k',
    ])
  })

  it('drops the trailing .0 on whole thousands', () => {
    expect(axisTick(2000)).toBe('$2k')
  })

  it('leaves sub-thousand ticks alone', () => {
    expect(axisTick(250)).toBe('$250')
    expect(axisTick(0)).toBe('$0')
  })
})

describe('shortDate', () => {
  it('renders a YYYY-MM-DD day without timezone drift', () => {
    // `new Date('2026-08-04')` is UTC midnight, which renders as 3 August west of Greenwich.
    // Parsing the string is what keeps a window labelled "Aug 4" starting on the 4th.
    expect(shortDate('2026-08-04')).toBe('Aug 4')
    expect(shortDate('2026-01-01')).toBe('Jan 1')
    expect(shortDate('2026-12-31')).toBe('Dec 31')
  })

  it('returns the input unchanged when it cannot be read', () => {
    expect(shortDate('not-a-date')).toBe('not-a-date')
  })

  // The dangerous branch is not the visible fallback but an out-of-range month: MONTH_LABELS[12]
  // is undefined, which renders the plausible-looking "undefined 5" instead of failing visibly.
  it('falls back visibly on an impossible month rather than rendering "undefined"', () => {
    expect(shortDate('2026-13-05')).toBe('2026-13-05')
    expect(shortDate('2026-99-05')).toBe('2026-99-05')
  })
})

describe('monthLabel', () => {
  it('names the month a whole-month window covers', () => {
    expect(monthLabel('2026-08-01')).toBe('Aug 2026')
    expect(monthLabel('2025-12-01')).toBe('Dec 2025')
  })

  // Formatted from the string's own parts in UTC. Built through `new Date(date)` instead, a
  // window opening on 1 August would render as July for anyone west of Greenwich — the card
  // would name a different month from the one its bars were summed over.
  it('does not drift into the month before', () => {
    expect(monthLabel('2026-01-01')).toBe('Jan 2026')
    expect(monthLabel('2026-03-01')).toBe('Mar 2026')
  })

  it('returns the input unchanged when it cannot be read', () => {
    expect(monthLabel('not-a-date')).toBe('not-a-date')
    expect(monthLabel('2026-13-01')).toBe('2026-13-01')
  })
})
