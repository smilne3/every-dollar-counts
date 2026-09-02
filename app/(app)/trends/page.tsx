import { createClient } from '@/lib/supabase/server'
import { spendByCategory, inRange, rollingWindows, type Txn } from '@/lib/budget'
import { sortedSpendRows } from '@/lib/breakdown'
import { type Category } from '@/lib/categories'
import { buildSpendContext } from '@/lib/spend-context'
import { shortDate } from '@/lib/format'
import { SpendByCategoryChart } from '@/components/SpendByCategoryChart'
import { PeriodOverPeriodChart } from '@/components/PeriodOverPeriodChart'
import { Card } from '@/components/ui/Card'
import { PageHeader } from '@/components/ui/PageHeader'

// Trends is deliberately not calendar-bound, unlike Budgets. Any window that opens on the 1st
// opens with the mortgage, so for the first fortnight of every month this page said "your money
// goes on the mortgage" — true, unchanging, and not what anyone opened it to learn (#67).
//
// The two pages now answer different questions on purpose: Budgets is "am I on track this
// month", Trends is "where does my money actually go". The card labels below name their window
// exactly so that difference is visible rather than confusing.
const WINDOW_DAYS = 30

export default async function TrendsPage() {
  const supabase = await createClient()

  const { current, previous } = rollingWindows(new Date(), WINDOW_DAYS)

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

  // Two full windows of the same length, so there is nothing to cap to keep the comparison
  // honest — the `throughDay` special case that did that for partial months (#9) is gone.
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
        subtitle={`Where your money goes over the last ${WINDOW_DAYS} days, and how that compares with the ${WINDOW_DAYS} before.`}
      />

      <Card className="p-5">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
          <h2 className="text-base font-semibold text-ink">Where the money went</h2>
          <span className="text-xs text-faint">
            Last {WINDOW_DAYS} days · {currentDates}
          </span>
        </div>
        <div className="mt-3">
          {spendData.length ? (
            <SpendByCategoryChart data={spendData} />
          ) : (
            <p className="text-sm text-muted">
              No spending recorded in the last {WINDOW_DAYS} days.
            </p>
          )}
        </div>
      </Card>

      <Card className="p-5">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
          <h2 className="text-base font-semibold text-ink">
            Last {WINDOW_DAYS} days vs the {WINDOW_DAYS} before
          </h2>
          <span className="text-xs text-faint">
            {currentDates} vs {previousDates}
          </span>
        </div>
        <div className="mt-3">
          {compareData.length ? (
            <PeriodOverPeriodChart
              data={compareData}
              currentLabel={`Last ${WINDOW_DAYS} days`}
              previousLabel={`Previous ${WINDOW_DAYS}`}
            />
          ) : (
            <p className="text-sm text-muted">Not enough data yet to compare periods.</p>
          )}
        </div>
      </Card>
    </div>
  )
}
