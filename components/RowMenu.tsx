'use client'

export function RowMenu({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <details className="text-right">
      <summary
        className="cursor-pointer list-none text-xs font-medium text-muted hover:text-ink"
        aria-label={`More actions for ${label}`}
      >
        ⋮
      </summary>
      <div className="mt-1 flex flex-col items-end gap-1">{children}</div>
    </details>
  )
}
