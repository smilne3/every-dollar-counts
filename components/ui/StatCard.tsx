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
      <div className="mt-2 text-3xl font-semibold tracking-tight tabular-nums text-ink">{value}</div>
      {foot != null && <div className="mt-1.5 text-sm">{foot}</div>}
    </Card>
  )
}
