import type { ReactNode } from 'react'
import Link from 'next/link'
import { Card } from './Card'
import { ChevronRightIcon } from './icons'
import { money } from '@/lib/format'

export type StatRow = {
  label: string
  amount: number
  currency?: string
  href: string
  tone?: 'ink' | 'coral'
  foot?: ReactNode
}

// The dashboard's supporting figures on a phone: one card, a row per figure, each row a link into
// its breakdown. It replaced three StatCard tiles side by side (spec §4, superseded there), which
// left each figure about 70px of text width at 390px: the Saved tile wrapped its note over five
// lines and broke "-$13,995" after the minus. iOS renders text wider than Chromium, so a local
// render at the same width did not show the break. A row gives the label and note the left of the
// card's width and the figure the right: the figure never wraps or shrinks, and the note has far
// more room than a tile gave it (it can still wrap at the narrowest widths). The dashboard shows
// this only below `md`; from `md` up it uses StatCard tiles.
//
// Figures are whole dollars. Spec §4 rounded the phone's figures alone; since the owner's decision of
// 2026-10-23 (#215) money() rounds every summary, the tiles from `md` up included, so the two layouts
// show each figure the same way. The caller's `tone` should come from the figure as shown, as the
// dashboard's does (lib/format.ts, moneyFigure).
export function StatRows({ rows }: { rows: StatRow[] }) {
  return (
    <Card className="divide-y divide-line overflow-hidden">
      {rows.map(({ label, amount, currency = 'USD', href, tone = 'ink', foot }) => (
        <Link
          key={href}
          href={href}
          className="flex min-h-[44px] items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-surface-2 md:min-h-0"
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
              {money(amount, currency)}
            </span>
            <ChevronRightIcon className="h-4 w-4 text-faint" />
          </div>
        </Link>
      ))}
    </Card>
  )
}
