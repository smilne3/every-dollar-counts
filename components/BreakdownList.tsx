import Link from 'next/link'
import { money } from '@/lib/format'

export type BreakdownRow = {
  key: string
  label: string
  sub?: string | null
  amount: number
  currency: string
  owed?: boolean
  href?: string
}

// Presentational list for a breakdown page: each row is a label + amount, optionally a drill link.
// A liability (`owed`) renders its amount as a negative in coral, matching AccountCard.
export function BreakdownList({
  rows,
  total,
}: {
  rows: BreakdownRow[]
  total?: { label: string; amount: number; currency: string }
}) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted">Nothing to show here yet.</p>
  }
  return (
    <ul className="divide-y divide-line">
      {rows.map((r) => {
        const amountEl = (
          <span className={`tabular-nums ${r.owed ? 'text-coral' : 'text-ink'}`}>
            {r.owed ? `−${money(r.amount, r.currency)}` : money(r.amount, r.currency)}
          </span>
        )
        const inner = (
          <div className="flex items-center justify-between py-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-ink">{r.label}</p>
              {r.sub && <p className="truncate text-xs text-muted capitalize">{r.sub}</p>}
            </div>
            {amountEl}
          </div>
        )
        return (
          <li key={r.key}>
            {r.href ? (
              <Link href={r.href} className="block transition-colors hover:bg-surface-2">
                {inner}
              </Link>
            ) : (
              inner
            )}
          </li>
        )
      })}
      {total && (
        <li className="flex items-center justify-between py-3 font-semibold">
          <span className="text-sm text-ink">{total.label}</span>
          <span className="tabular-nums text-ink">{money(total.amount, total.currency)}</span>
        </li>
      )}
    </ul>
  )
}
