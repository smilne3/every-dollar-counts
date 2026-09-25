import { money, shortDate } from '@/lib/format'
import { TONE_CLASS, type PresentedTxn } from '@/lib/transaction-presentation'
import { ArrowUpRightIcon, ArrowDownLeftIcon } from './ui/icons'

// Already presented by the caller. This list used to flip the Plaid sign and re-implement the tone
// mapping itself, which made it the third place those rules lived — see the note this removes from
// lib/transaction-presentation.ts.
export type ActivityItem = {
  id: string
  date: string
  category: string
  label: string
  display: number
  tone: PresentedTxn['tone']
  // Internal movement, not card-payments-only: a checking -> savings transfer is equally "your own
  // money moving" and read as a paycheque arriving until this used the wider flag.
  isInternal: boolean
}

// The icon's palette is NOT TONE_CLASS and deliberately so: an outflow is coral in the icon but
// `text-ink` in the figure, because the icon is a glyph on a tinted chip and the figure is text in
// a column. Keyed off the shared `tone` so it cannot disagree about WHAT a row is, only about how
// this one list draws it.
const ICON_CLASS: Record<PresentedTxn['tone'], string> = {
  out: 'bg-coral-050 text-coral',
  in: 'bg-emerald-050 text-emerald',
  neutral: 'bg-surface-2 text-faint',
}

export function RecentActivity({ items }: { items: ActivityItem[] }) {
  if (items.length === 0) {
    return <p className="text-sm text-muted">No transactions yet.</p>
  }
  return (
    <ul className="divide-y divide-line">
      {items.map((t) => (
        <li key={t.id} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
          <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${ICON_CLASS[t.tone]}`}>
            {t.display > 0 ? (
              <ArrowDownLeftIcon className="h-4 w-4" />
            ) : (
              <ArrowUpRightIcon className="h-4 w-4" />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-ink">{t.label}</div>
            <div className="truncate text-xs text-muted">
              {t.isInternal ? 'Between your accounts' : t.category} · {shortDate(t.date)}
            </div>
          </div>
          <div className={`shrink-0 text-sm font-medium tabular-nums ${TONE_CLASS[t.tone]}`}>
            {t.tone === 'in' ? '+' : ''}
            {money(t.display)}
          </div>
        </li>
      ))}
    </ul>
  )
}
