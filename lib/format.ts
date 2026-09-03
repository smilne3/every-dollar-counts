export function money(amount: number | null | undefined, currency = 'USD'): string {
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
