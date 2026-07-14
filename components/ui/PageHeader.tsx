import type { ReactNode } from 'react'

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">{title}</h1>
        {subtitle != null && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      {actions != null && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}
