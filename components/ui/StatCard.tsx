import type { ReactNode } from 'react'
import { Card } from './Card'

// A KPI tile: small uppercase label, big number, optional footnote.
export function StatCard({
  label,
  value,
  foot,
}: {
  label: string
  value: ReactNode
  foot?: ReactNode
}) {
  return (
    <Card className="p-5">
      <div className="text-xs font-semibold uppercase tracking-wide text-faint">{label}</div>
      {/* Scaled down on small screens: a figure like -$40,452.32 overflows the tile in
          the 2-column mobile grid at anything above text-xl. */}
      <div className="mt-2 text-xl font-semibold tracking-tight tabular-nums text-ink sm:text-2xl lg:text-3xl">
        {value}
      </div>
      {foot != null && <div className="mt-1.5 text-sm">{foot}</div>}
    </Card>
  )
}
