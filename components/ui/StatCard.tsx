import type { ReactNode } from 'react'
import Link from 'next/link'
import { Card } from './Card'
import { ChevronRightIcon } from './icons'
import { money } from '@/lib/format'

// A KPI tile: small uppercase label, big number, optional footnote. When `href` is set the whole
// tile becomes a link that drills into a breakdown of the number.
//
// Takes the NUMBER, not a formatted string. It used to take a ReactNode, and every caller passed
// the output of money(), so the tile could not decide how its figure is shown; now it formats it,
// and the §9 formatting test has something to assert against. Both variants show the figure in
// whole dollars, as StatRows does on a phone: net worth was exact under spec §4 until the owner
// reversed that on 2026-10-23 (#215). The caller's `tone` should come from the figure as shown
// (lib/format.ts, moneyFigure).
export function StatCard({
  label,
  amount,
  currency = 'USD',
  variant = 'compact',
  tone = 'ink',
  foot,
  href,
}: {
  label: string
  amount: number
  currency?: string
  // `hero`: the largest type below `md`, for the figure that must never be abbreviated. The width it
  // needs comes from how the caller lays the tile out, not from here.
  // `compact`: sized for a tile in the md-and-up grid, the only place one is shown. Below md the
  // dashboard, its one caller, shows StatRows instead (#136), so it has no phone sizing (#137). A
  // compact tile on a phone would need it back.
  variant?: 'hero' | 'compact'
  tone?: 'ink' | 'coral'
  foot?: ReactNode
  href?: string
}) {
  const toneClass = tone === 'coral' ? 'text-coral' : 'text-ink'
  // The compact tile's text-2xl is what it had from md up before #137 (`text-xl sm:text-2xl`).
  const figureClass = `mt-2 font-semibold tracking-tight tabular-nums ${toneClass} ${
    variant === 'hero' ? 'text-3xl md:text-2xl lg:text-3xl' : 'text-2xl lg:text-3xl'
  }`

  const body = (
    <>
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-wide text-faint">{label}</div>
        {href && <ChevronRightIcon className="h-4 w-4 text-faint" />}
      </div>
      {/* Every dollar, at every width: never abbreviated, whatever the character count, and since
          #215 never with cents. The hero is the figure §1.3 is about; giving it room to render is
          the caller's half of the fix, and rendering it in full is this component's half. */}
      <div className={figureClass}>{money(amount, currency)}</div>
      {foot != null && <div className="mt-1.5 text-sm">{foot}</div>}
    </>
  )
  if (href) {
    return (
      <Link href={href} className="block min-h-[44px] md:min-h-0">
        <Card className="p-5 transition-colors hover:bg-surface-2">{body}</Card>
      </Link>
    )
  }
  return <Card className="p-5">{body}</Card>
}
