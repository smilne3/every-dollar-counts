import Link from 'next/link'
import { LearnedIcon } from './ui/icons'

// The words for a row a merchant rule relabelled (#28 spec §8.1). One string, so the desktop link
// and the phone card cannot describe the same thing differently.
export function learnedText(category: string, merchant: string | null): string {
  return `${category}, learned from ${merchant?.trim() || 'this merchant'}. Manage in Settings → Category rules.`
}

// Beside the desktop picker. shrink-0, and the same height as the desktop select (py-1.5 + a 20px
// line + a 2px border = 34px) so the icon centres on it, while the cell's items-start keeps it at
// the top when a save error grows the picker's column.
export function LearnedMarker({ category, merchant }: { category: string; merchant: string | null }) {
  const text = learnedText(category, merchant)
  return (
    <Link
      href="/settings#category-rules"
      title={text}
      aria-label={text}
      className="flex h-[34px] shrink-0 items-center rounded text-faint transition-colors hover:text-emerald focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald/40"
    >
      <LearnedIcon className="h-3.5 w-3.5" />
    </Link>
  )
}
