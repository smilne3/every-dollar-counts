import Link from 'next/link'
import { money, moneyExact, moneyFigure } from '@/lib/format'

export type BreakdownRow = {
  key: string
  label: string
  sub?: string | null
  amount: number
  currency: string
  owed?: boolean
  // To the cent, where every other row is whole dollars. Only for the owed-to-you total, which keeps
  // its cents wherever it appears (owner decision, 2026-10-30, #215).
  exact?: boolean
  href?: string
}

// Presentational list for a breakdown page: each row is a label + amount, optionally a drill link.
// Amounts are whole dollars, but for a row marked `exact`, the owed-to-you total (#215).
// A liability (`owed`) renders its amount as a negative in coral, matching AccountCard, by the
// figure shown: one under 50 cents shows "$0", not "−$0" (#215).
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
        const figure = r.exact
          ? { value: r.amount, text: moneyExact(r.amount, r.currency) }
          : moneyFigure(r.amount, r.currency)
        const negative = r.owed && figure.value !== 0
        const amountEl = (
          <span className={`tabular-nums ${negative ? 'text-coral' : 'text-ink'}`}>
            {negative ? `−${figure.text}` : figure.text}
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
              <Link href={r.href} className="block min-h-[44px] transition-colors hover:bg-surface-2 md:min-h-0">
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
