import { money } from '@/lib/format'
import { ArrowUpRightIcon, ArrowDownLeftIcon } from './ui/icons'

export type ActivityItem = {
  id: string
  name: string
  category: string
  date: string
  amount: number
}

const MONTH_LABELS = [
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

// 'YYYY-MM-DD' -> 'Jul 12' without timezone drift.
function shortDate(date: string): string {
  const m = Number(date.slice(5, 7))
  const d = Number(date.slice(8, 10))
  if (!m || !d) return date
  return `${MONTH_LABELS[m - 1]} ${d}`
}

export function RecentActivity({ items }: { items: ActivityItem[] }) {
  if (items.length === 0) {
    return <p className="text-sm text-muted">No transactions yet.</p>
  }
  return (
    <ul className="divide-y divide-line">
      {items.map((t) => {
        // Plaid: amount > 0 = money out (expense), amount < 0 = money in (income).
        const inflow = t.amount < 0
        const display = -t.amount
        return (
          <li key={t.id} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
            <span
              className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${
                inflow ? 'bg-emerald-050 text-emerald' : 'bg-coral-050 text-coral'
              }`}
            >
              {inflow ? (
                <ArrowDownLeftIcon className="h-4 w-4" />
              ) : (
                <ArrowUpRightIcon className="h-4 w-4" />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-ink">{t.name}</div>
              <div className="truncate text-xs text-muted">
                {t.category} · {shortDate(t.date)}
              </div>
            </div>
            <div
              className={`shrink-0 text-sm font-medium tabular-nums ${
                inflow ? 'text-emerald' : 'text-ink'
              }`}
            >
              {inflow ? '+' : ''}
              {money(display)}
            </div>
          </li>
        )
      })}
    </ul>
  )
}
