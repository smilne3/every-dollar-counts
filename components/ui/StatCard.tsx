import type { ReactNode } from 'react'
import Link from 'next/link'
import { Card } from './Card'
import { ChevronRightIcon } from './icons'

// A KPI tile: small uppercase label, big number, optional footnote. When `href` is set the whole
// tile becomes a link that drills into a breakdown of the number.
export function StatCard({
  label,
  value,
  foot,
  href,
}: {
  label: string
  value: ReactNode
  foot?: ReactNode
  href?: string
}) {
  const body = (
    <>
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-wide text-faint">{label}</div>
        {href && <ChevronRightIcon className="h-4 w-4 text-faint" />}
      </div>
      {/* Scaled down on small screens: a figure like -$40,452.32 overflows the tile in
          the 2-column mobile grid at anything above text-xl. */}
      <div className="mt-2 text-xl font-semibold tracking-tight tabular-nums text-ink sm:text-2xl lg:text-3xl">
        {value}
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
