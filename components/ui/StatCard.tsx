import type { ReactNode } from 'react'
import Link from 'next/link'
import { Card } from './Card'
import { ChevronRightIcon } from './icons'
import { money, moneyWhole } from '@/lib/format'

// A KPI tile: small uppercase label, big number, optional footnote. When `href` is set the whole
// tile becomes a link that drills into a breakdown of the number.
//
// Takes the NUMBER, not a formatted string. It used to take a ReactNode, and every caller passed
// the output of money() — so by the time the tile saw the figure the cents were already baked in
// and it could not choose between a rounded and an exact rendering at different widths. That
// choice is the whole point of this stage, which is why the prop had to change. The tile owns the
// formatting now, so the rounding rule is in one place and the §9 formatting test has something
// to assert against.
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
  // `hero`: always exact, and the largest type below `md` — for the figure that must never be
  // abbreviated. The width it needs comes from how the caller lays the tile out, not from here.
  // `compact`: rounded below `md` where the width is not there, exact from `md` up.
  variant?: 'hero' | 'compact'
  tone?: 'ink' | 'coral'
  foot?: ReactNode
  href?: string
}) {
  const toneClass = tone === 'coral' ? 'text-coral' : 'text-ink'
  const figureClass = `mt-2 font-semibold tracking-tight tabular-nums ${toneClass} ${
    variant === 'hero' ? 'text-3xl md:text-2xl lg:text-3xl' : 'text-xl sm:text-2xl lg:text-3xl'
  }`

  const body = (
    <>
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-wide text-faint">{label}</div>
        {href && <ChevronRightIcon className="h-4 w-4 text-faint" />}
      </div>
      <div className={figureClass}>
        {variant === 'hero' ? (
          // Always exact, at every width — never the rounded string, whatever the character
          // count. This is the figure §1.3 is about. Giving it room to render is the caller's
          // half of the fix; rendering it in full is this component's half.
          money(amount, currency)
        ) : (
          // One server-rendered document serves both viewports, so the choice cannot be made in
          // JS. Both strings ship and CSS picks. `hidden` is display:none, so the one that is not
          // shown is also out of the accessibility tree — a screen reader hears one figure.
          <>
            <span className="md:hidden">{moneyWhole(amount, currency)}</span>
            <span className="hidden md:inline">{money(amount, currency)}</span>
          </>
        )}
      </div>
      {foot != null && <div className="mt-1.5 text-sm">{foot}</div>}
    </>
  )
  if (href) {
    return (
      <Link href={href} className="block">
        <Card className="p-5 transition-colors hover:bg-surface-2">{body}</Card>
      </Link>
    )
  }
  return <Card className="p-5">{body}</Card>
}
