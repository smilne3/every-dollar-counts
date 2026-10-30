import Link from 'next/link'
import { moneyExact } from '@/lib/format'

// The dashboard's link to what the household is owed back, shown for any amount above zero.
//
// To the cent: the one total on the dashboard that is, like the reimbursements page's own "You're
// owed …" it leads to (owner decision, 2026-10-23, #215). The total is checked to the cent,
// against an expense report and then the repayment, and rounded, a 30-cent remainder would read
// "Owed to you $0". It is a component of its own so the dashboard page has no reason to import
// moneyExact, whose allowed files tests/unit/money-exact-imports.test.ts lists.
export function OwedToYouLink({ amount, currency = 'USD' }: { amount: number; currency?: string }) {
  if (!(amount > 0)) return null
  const owed = moneyExact(amount, currency)
  return (
    <Link
      href="/reimbursements"
      aria-label={`Owed to you: ${owed}`}
      className="flex min-h-[44px] items-center justify-between rounded-lg border border-line px-4 py-3 text-sm hover:bg-surface-2 md:min-h-0"
    >
      <span className="text-muted">Owed to you</span>
      <span className="font-medium tabular-nums text-ink">{owed}</span>
    </Link>
  )
}
