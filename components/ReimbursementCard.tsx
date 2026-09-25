import { money, shortDate } from '@/lib/format'

// One marked expense, below `md`, where the four-column table has nowhere to put itself. Same shape
// as the transactions card (spec §3.1): what it was and how much on the first line, the quieter
// facts on a second.
//
// Takes a RESOLVED label and a RESOLVED amount. The outstanding list passes what is still owed and
// the covered list passes the full reimbursed figure — two different quantities that the desktop
// table is careful to label differently. Giving this component a `variant` instead would move that
// choice in here, where it would be possible to render one list's figure under the other's heading.
export function ReimbursementCard({
  label,
  amount,
  date,
  note,
}: {
  label: string
  amount: number
  date: string
  note?: string | null
}) {
  // trim(), not merely truthiness: `''` is already falsy and takes the same branch without it, but
  // a note of '   ' is NOT, and would render "Sep 1 ·    " — a separator pointing at nothing. The
  // second trim() keeps a padded name from rendering with its padding.
  const who = note?.trim() ? note.trim() : null
  return (
    <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium text-ink">{label}</div>
        <div className="mt-0.5 truncate text-xs text-muted">
          {who ? `${shortDate(date)} · ${who}` : shortDate(date)}
        </div>
      </div>
      <div className="shrink-0 whitespace-nowrap font-medium tabular-nums text-ink">{money(amount)}</div>
    </div>
  )
}
