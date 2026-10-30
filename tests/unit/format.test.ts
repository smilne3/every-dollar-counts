import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  axisTick,
  shortDate,
  monthLabel,
  longDate,
  monthNameLong,
  money,
  moneyExact,
  moneyFigure,
  shortDateAcrossYears,
} from '@/lib/format'

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

describe('longDate', () => {
  it('names the weekday, month and day of a calendar date', () => {
    expect(longDate('2026-09-02')).toBe('Wednesday, September 2')
    expect(longDate('2026-01-01')).toBe('Thursday, January 1')
  })

  // The whole point: built from the string's own digits through Date.UTC, so it cannot render the
  // day before west of Greenwich the way `new Date('2026-09-02')` would.
  it('does not drift to the previous day', () => {
    expect(longDate('2026-03-01')).toBe('Sunday, March 1')
    expect(longDate('2026-12-31')).toBe('Thursday, December 31')
  })

  it('returns the input unchanged when it cannot be read', () => {
    expect(longDate('not-a-date')).toBe('not-a-date')
    expect(longDate('2026-13-01')).toBe('2026-13-01')
  })
})

describe('monthNameLong', () => {
  it('names the month of a YYYY-MM key', () => {
    expect(monthNameLong('2026-09')).toBe('September')
    expect(monthNameLong('2026-01')).toBe('January')
  })

  // It is handed keys from lastNMonths, which are 'YYYY-MM'; a full date must still work rather
  // than silently returning the input, because the two shapes are easy to mix up.
  it('accepts a full date too', () => {
    expect(monthNameLong('2026-09-02')).toBe('September')
  })

  it('returns the input unchanged when it cannot be read', () => {
    expect(monthNameLong('nope')).toBe('nope')
    expect(monthNameLong('2026-99')).toBe('2026-99')
  })
})

// Whole dollars are the default since #215 (owner decision, 2026-10-23): every amount but the
// transactions themselves and what is owed back on them.
describe('money', () => {
  // Cents on a summary buy nothing, and on a phone cost the characters that made §1.3 clip.
  it('drops the cents', () => {
    expect(money(34920.49)).toBe('$34,920')
    expect(money(8776.51)).toBe('$8,777')
  })

  // Rounding is for READING. A negative figure keeps its minus and its symbol, and one that rounds
  // to zero is a plain "$0" (below), never an empty string.
  it('keeps the sign and the symbol on a negative figure', () => {
    expect(money(-5449)).toBe('-$5,449')
  })

  it('renders zero as zero, not as an empty string', () => {
    expect(money(0)).toBe('$0')
  })

  // moneyExact treats null as zero; the rounded form must not disagree with it.
  it('treats null and undefined as zero, exactly as moneyExact does', () => {
    expect(money(null)).toBe('$0')
    expect(money(undefined)).toBe('$0')
  })

  it('honours a non-default currency', () => {
    expect(money(1200, 'EUR')).toBe('€1,200')
  })

  // #215: a loss of 30 cents printed "-$0", and the phone's Saved row showed it in coral.
  it('never prints "-$0"', () => {
    expect(money(-0.3)).toBe('$0')
    expect(money(-0.49)).toBe('$0')
    expect(money(-0)).toBe('$0')
  })

  // Intl's rule, half away from zero, both ways. Math.round, which the average line coloured by,
  // rounds -0.5 up to 0.
  it('rounds half away from zero', () => {
    expect(money(0.5)).toBe('$1')
    expect(money(-0.5)).toBe('-$1')
    expect(money(2.5)).toBe('$3')
    expect(money(-2.5)).toBe('-$3')
    expect(money(1234.5)).toBe('$1,235')
  })

  describe('where Intl.NumberFormat predates v3', () => {
    afterEach(() => {
      vi.restoreAllMocks()
    })

    // Budgets, Goals, the home value, the account cards and the charts format in the phone's own
    // browser (#215). Before v3, which arrived in Safari 15.4, Chrome 106 and Firefox 116, a maximum
    // below the currency's default minimum of 2 threw a RangeError rather than lowering the minimum
    // to meet it. Node is past v3, so the old rule is put back here, around the real formatter.
    it('still formats, as both limits are given', () => {
      const Real = Intl.NumberFormat
      vi.spyOn(Intl, 'NumberFormat').mockImplementation(function (
        locales?: string | string[],
        options: Intl.NumberFormatOptions = {}
      ) {
        const minimum = options.minimumFractionDigits ?? (options.style === 'currency' ? 2 : 0)
        if (options.maximumFractionDigits !== undefined && options.maximumFractionDigits < minimum) {
          throw new RangeError('maximumFractionDigits value is out of range.')
        }
        return new Real(locales, options)
      } as never)
      expect(money(1234.5)).toBe('$1,235')
      expect(moneyExact(1234.5)).toBe('$1,234.50')
    })
  })
})

// What a colour or a minus sign beside a figure is decided from: the figure on screen, as a number
// (#215).
describe('moneyFigure', () => {
  it('hands back the figure it prints', () => {
    expect(moneyFigure(1234.5)).toEqual({ value: 1235, text: '$1,235' })
    expect(moneyFigure(-0.5)).toEqual({ value: -1, text: '-$1' })
    expect(moneyFigure(2.5)).toEqual({ value: 3, text: '$3' })
    expect(moneyFigure(0.5)).toEqual({ value: 1, text: '$1' })
  })

  // `value < 0` is false for -0, so no colour would show it, but Intl prints it "-$0". toEqual
  // compares numbers with Object.is, so it tells -0 from 0.
  it('turns negative zero into zero', () => {
    expect(moneyFigure(-0.3)).toEqual({ value: 0, text: '$0' })
    expect(moneyFigure(-0)).toEqual({ value: 0, text: '$0' })
  })

  // A debt of 30 cents is still whole dollars: $0, not a figure for a minus sign to go on.
  it('rounds a small amount either side of zero to a plain zero', () => {
    expect(moneyFigure(0.3)).toEqual({ value: 0, text: '$0' })
    expect(moneyFigure(0.49)).toEqual({ value: 0, text: '$0' })
    expect(moneyFigure(-0.49).text).toBe('$0')
  })

  it('treats null and undefined as zero', () => {
    expect(moneyFigure(null)).toEqual({ value: 0, text: '$0' })
    expect(moneyFigure(undefined)).toEqual({ value: 0, text: '$0' })
  })

  it('honours a non-default currency', () => {
    expect(moneyFigure(1199.5, 'EUR')).toEqual({ value: 1200, text: '€1,200' })
  })
})

// To the cent: the transactions themselves, and what is owed back on them (#215).
describe('moneyExact', () => {
  it('keeps the cents', () => {
    expect(moneyExact(1234.56)).toBe('$1,234.56')
    expect(moneyExact(-60)).toBe('-$60.00')
  })

  it('treats null and undefined as zero', () => {
    expect(moneyExact(null)).toBe('$0.00')
    expect(moneyExact(undefined)).toBe('$0.00')
  })

  it('honours a non-default currency', () => {
    expect(moneyExact(1200, 'EUR')).toBe('€1,200.00')
  })
})

describe('shortDateAcrossYears', () => {
  // The outstanding reimbursements list has no window and no grouping — its own page comment says
  // "an expense from last year is still owed" — so two rows a year apart both read "Sep 1" with
  // nothing to tell them apart. Every other list in the app is month- or period-scoped, which is
  // why plain shortDate is right everywhere else.
  it('omits the year when it is the current one', () => {
    expect(shortDateAcrossYears('2026-09-01', '2026')).toBe('Sep 1')
  })

  it('shows the year when it is not', () => {
    expect(shortDateAcrossYears('2025-09-01', '2026')).toBe('Sep 1, 2025')
  })

  // A future-dated row is as ambiguous as an old one.
  it('shows a future year too', () => {
    expect(shortDateAcrossYears('2027-01-15', '2026')).toBe('Jan 15, 2027')
  })

  // shortDate hands back the input unchanged when it cannot read the date. Appending a year to
  // that would dress up a value we could not parse.
  it('passes an unreadable date straight through, without inventing a year', () => {
    expect(shortDateAcrossYears('not-a-date', '2026')).toBe('not-a-date')
    expect(shortDateAcrossYears('2026-13-01', '2026')).toBe('2026-13-01')
  })
})
