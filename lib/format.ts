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
