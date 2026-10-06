import type { ReactNode } from 'react'
import Link from 'next/link'
import { Card } from './Card'
import { ChevronRightIcon } from './icons'
import { moneyWhole } from '@/lib/format'

export type StatRow = {
  label: string
  amount: number
  currency?: string
  href: string
  tone?: 'ink' | 'coral'
  foot?: ReactNode
}

// The dashboard's supporting figures on a phone: one card, a row per figure, each row a link into
// its breakdown. It replaced three StatCard tiles side by side, which left each figure about 76px at
// 390px: the Saved tile wrapped its note over five lines and broke "-$13,995" after the minus on
// the owner's iPhone (2026-10-06). A row gives the label and note the left of the full width and the
// figure the right, so neither has to give way. From `md` up the tiles have the room and return.
//
// Figures are whole dollars, as the compact tiles were below `md` (spec §4), and never wrap.
export function StatRows({ rows }: { rows: StatRow[] }) {
  return (
    <Card className="divide-y divide-line">
      {rows.map(({ label, amount, currency = 'USD', href, tone = 'ink', foot }) => (
        <Link
          key={href}
          href={href}
          className="flex items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-surface-2"
        >
          <div className="min-w-0">
            <div className="text-xs font-semibold uppercase tracking-wide text-faint">{label}</div>
            {foot != null && <div className="mt-0.5 text-sm text-muted">{foot}</div>}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <span
              className={`whitespace-nowrap text-xl font-semibold tracking-tight tabular-nums ${
                tone === 'coral' ? 'text-coral' : 'text-ink'
              }`}
            >
              {moneyWhole(amount, currency)}
            </span>
            <ChevronRightIcon className="h-4 w-4 text-faint" />
          </div>
        </Link>
      ))}
    </Card>
  )
}
