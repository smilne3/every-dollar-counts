// An amount as the app shows it: whole dollars. Everywhere but the transactions themselves, the
// reimbursements, and the owed-to-you total wherever it appears, which keep their cents through
// moneyExact (owner decisions, 2026-10-23 and 2026-10-30, #215). Cents on a summary are digits nobody
// acts on, and on a phone they cost the width a figure needs (#136). Being the default, a new summary
// is whole dollars without anyone choosing it.
//
// Rounding is a DISPLAY choice: what this returns is only ever shown, never stored or added into a
// total. So rounded parts need not add up to the rounded total beside them, and nothing should make
// them: three categories of $10.40 show as $10 each beside a $31 total.
export function money(amount: number | null | undefined, currency = 'USD'): string {
  return moneyFigure(amount, currency).text
}

// money(), with the figure it shows. Whatever an amount decides beside it, a colour or a minus sign,
// is decided from `value`, the figure on screen, not from the amount before rounding: 30 cents below
// zero shows "$0", which is not a loss, so it is not coral, and 50 cents below shows "-$1", which is
// a loss, and coral (#215).
//
// Rounded here, half away from zero, which is Intl's rule, and Intl is handed the result, so it has
// nothing left to round and `value` and `text` cannot disagree. Negative zero becomes zero: Intl
// prints -0 as "-$0".
export function moneyFigure(
  amount: number | null | undefined,
  currency = 'USD'
): { value: number; text: string } {
  const exact = amount ?? 0
  const whole = Math.sign(exact) * Math.round(Math.abs(exact))
  // -0 === 0, so a small negative amount, rounded to -0, comes out of this as 0.
  const value = whole === 0 ? 0 : whole
  return {
    value,
    text: new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      // Both limits, not the maximum alone. Before Intl.NumberFormat v3 a maximum below the
      // currency's own minimum (2, for USD) throws a RangeError, and the client components that
      // call this format in the phone's own browser.
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(value),
  }
}

// To the cent, for the transactions themselves, the reimbursements, and the owed-to-you total wherever
// it appears: on the dashboard, the reimbursements page and the net-worth breakdown. A transaction is
// read against the bank's statement, and what is owed is checked against an expense report and then
// the repayment (owner decisions, 2026-10-23 and 2026-10-30, #215).
// tests/unit/money-exact-imports.test.ts names the files allowed it, so a summary cannot pick up
// cents by importing the wrong formatter.
export function moneyExact(amount: number | null | undefined, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount ?? 0)
}

// Compact axis tick: 1500 -> "$1.5k", 3000 -> "$3k", 250 -> "$250".
// Rounding to whole thousands mislabels the evenly-spaced gridlines recharts picks:
// 0/1500/3000/4500/6000 would read $0/$2k/$3k/$5k/$6k, so a bar at 1500 sits on a
// line labelled "$2k".
export function axisTick(v: number): string {
  if (Math.abs(v) < 1000) return `$${v}`
  return `$${(v / 1000).toFixed(1).replace(/\.0$/, '')}k`
}

export const MONTH_LABELS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]

// 'YYYY-MM-DD' -> 'Jul 12' without timezone drift. Parsing the string beats `new Date(date)`,
// which reads a bare date as UTC midnight and can render the day before in a western timezone.
export function shortDate(date: string): string {
  const m = Number(date.slice(5, 7))
  const d = Number(date.slice(8, 10))
  // Bound the month, not just its truthiness: MONTH_LABELS[12] is undefined, so an unchecked
  // month renders the plausible-looking "undefined 5" rather than falling back visibly.
  if (!m || m > 12 || !d) return date
  return `${MONTH_LABELS[m - 1]} ${d}`
}

// shortDate, qualified with the year when that year is not the current one — "Sep 1" or
// "Sep 1, 2025". For a list that is NOT scoped to a month or a period, where two rows a year apart
// would otherwise read identically.
//
// Only the reimbursements outstanding list needs this today, and it needs it because that list is
// deliberately unbounded: see the comment on its query, "an expense from last year is still owed".
// Every other list in the app is month- or period-scoped, so plain shortDate stays right there and
// the phone keeps the short form in the common case (#111).
//
// `currentYear` is passed in rather than read from the clock here, because "the current year" is
// the HOUSEHOLD's, not the server's — the mistake #73 was about. Callers get it from
// todayIn(householdTimezone()).
export function shortDateAcrossYears(date: string, currentYear: string): string {
  const short = shortDate(date)
  // shortDate returns its input unchanged when it cannot read the date. Appending a year to that
  // would dress up a value we could not parse.
  if (short === date) return short
  return date.slice(0, 4) === currentYear ? short : `${short}, ${date.slice(0, 4)}`
}

// 'YYYY-MM-DD' -> 'Aug 2026', for labelling a window that is a whole calendar month.
//
// Indexed straight out of MONTH_LABELS rather than formatted through a Date. Any route via
// `new Date(date)` reads a bare date as UTC midnight, so west of Greenwich a window opening on
// 1 August renders as July — the card would name a different month from the one its bars were
// summed over. Building from the string's own digits removes that rather than testing for it,
// which matters here because the suite runs east of UTC, where such a slip does not show.
export function monthLabel(date: string): string {
  const year = date.slice(0, 4)
  const m = Number(date.slice(5, 7))
  if (!/^\d{4}$/.test(year) || !m || m > 12) return date
  return `${MONTH_LABELS[m - 1]} ${year}`
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

// 'YYYY-MM-DD' -> 'Wednesday, September 2'.
//
// The weekday comes from a Date built with Date.UTC and read back with getUTCDay, so the
// construction and the read are in the same zone and cancel out. `new Date('2026-09-02')` would
// be UTC midnight and render as 1 September for anyone west of Greenwich.
export function longDate(date: string): string {
  const y = Number(date.slice(0, 4))
  const m = Number(date.slice(5, 7))
  const d = Number(date.slice(8, 10))
  if (!y || !m || m > 12 || !d || d > 31) return date
  const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]
  return `${weekday}, ${MONTH_NAMES[m - 1]} ${d}`
}

// 'YYYY-MM' (or 'YYYY-MM-DD') -> 'September', for a tile that names the month in full.
export function monthNameLong(key: string): string {
  const m = Number(key.slice(5, 7))
  if (!m || m > 12) return key
  return MONTH_NAMES[m - 1]
}
