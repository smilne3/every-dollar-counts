import { createClient } from '@/lib/supabase/server'
import { spendByCategory, inRange, rollingMonths, type Txn } from '@/lib/budget'
import { sortedSpendRows } from '@/lib/breakdown'
import { type Category } from '@/lib/categories'
import { buildSpendContext } from '@/lib/spend-context'
import { shortDate } from '@/lib/format'
import { SpendByCategoryChart } from '@/components/SpendByCategoryChart'
import { PeriodOverPeriodChart } from '@/components/PeriodOverPeriodChart'
import { Card } from '@/components/ui/Card'
import { PageHeader } from '@/components/ui/PageHeader'

// Trends does not start on the 1st, unlike Budgets. Any window that does opens with the
// mortgage, so for the first fortnight of every month this page said "your money goes on the
// mortgage" — true, unchanging, and not what anyone opened it to learn (#67).
//
// The two pages now answer different questions on purpose: Budgets is "am I on track this
// month", Trends is "where does my money actually go". The card labels below name their window
// with real dates so that difference reads as intent rather than as a bug.

export default async function TrendsPage() {
  const supabase = await createClient()

  const { current, previous } = rollingMonths(new Date())

  const { data: cats } = await supabase
    .from('categories')
    .select('id, name, pfc_primary, sort_order')
    .order('sort_order')
  const categories = (cats ?? []) as Category[]

  // Bounded at both ends: `previous.from` is as far back as either chart looks, and `current.to`
  // keeps a future-dated row out of a window it has not happened in yet.
  const { data: txns } = await supabase
    .from('transactions')
    .select('id, amount, date, user_category, pfc_primary, pfc_detailed, reimbursable_amount')
    .eq('removed', false)
    .gte('date', previous.from)
    .lte('date', current.to)

  // The reimbursable map is built straight from this page's own transaction rows — see
  // buildSpendContext.
  const ctx = buildSpendContext({ categories, txns: (txns ?? []) as Txn[] })
  const list = (txns ?? []) as Txn[]

  const currentByCat = spendByCategory(inRange(list, current.from, current.to), ctx)
  const previousByCat = spendByCategory(inRange(list, previous.from, previous.to), ctx)

  const spendData = sortedSpendRows(currentByCat)

  // A full window on each side, each holding exactly one of any monthly bill, so there is
  // nothing to cap to keep the comparison honest — the `throughDay` special case that did that
  // for partial months (#9) is gone.
  const names = Array.from(new Set([...Object.keys(currentByCat), ...Object.keys(previousByCat)]))
  const compareData = names
    .map((category) => ({
      category,
      current: currentByCat[category] ?? 0,
      previous: previousByCat[category] ?? 0,
    }))
    .sort((a, b) => b.current + b.previous - (a.current + a.previous))

  const currentDates = `${shortDate(current.from)} – ${shortDate(current.to)}`
  const previousDates = `${shortDate(previous.from)} – ${shortDate(previous.to)}`

  return (
    <div className="space-y-6">
      <PageHeader
        title="Trends"
        subtitle="Where your money goes over the past month, and how that compares with the month before."
      />

      <Card className="p-5">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
          <h2 className="text-base font-semibold text-ink">Where the money went</h2>
          <span className="text-xs text-faint">Past month · {currentDates}</span>
        </div>
        <div className="mt-3">
          {spendData.length ? (
            <SpendByCategoryChart data={spendData} />
          ) : (
            <p className="text-sm text-muted">No spending recorded in the past month.</p>
          )}
        </div>
      </Card>

      <Card className="p-5">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
          <h2 className="text-base font-semibold text-ink">Past month vs the month before</h2>
          <span className="text-xs text-faint">
            {currentDates} vs {previousDates}
          </span>
        </div>
        <div className="mt-3">
          {compareData.length ? (
            <PeriodOverPeriodChart
              data={compareData}
              currentLabel="Past month"
              previousLabel="Month before"
            />
          ) : (
            <p className="text-sm text-muted">Not enough data yet to compare periods.</p>
          )}
        </div>
      </Card>
    </div>
  )
}
