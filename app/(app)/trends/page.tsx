import { createClient } from '@/lib/supabase/server'
import { lastCompleteMonths } from '@/lib/budget'
import { trendsView } from '@/lib/trends'
import { todayIn } from '@/lib/clock'
import { currentHouseholdId, householdTimezone } from '@/lib/household'
import { fetchCategoryContext, SUGGESTION_EMBED, withSuggestion } from '@/lib/category-context'
import { buildSpendContext } from '@/lib/spend-context'
import { listItemsForHousehold } from '@/lib/plaid-items'
import { SpendByCategoryChart } from '@/components/SpendByCategoryChart'
import { PeriodOverPeriodChart } from '@/components/PeriodOverPeriodChart'
import { NotSyncingBanner } from '@/components/NotSyncingBanner'
import { Card } from '@/components/ui/Card'
import { PageHeader } from '@/components/ui/PageHeader'
import { readAllRows } from '@/lib/read-all'

// Trends reports the last month that has FINISHED; Budgets reports the calendar month so far.
// That is the whole of #67: a month still in progress is, for its first fortnight, almost
// entirely the mortgage — true, unchanging, and not what anyone opened this page to learn.
//
// The two pages therefore answer different questions on purpose — "where does my money go"
// against "am I on track this month" — so every label here names its month outright, and the page
// deliberately says nothing about the month you are currently in.
export default async function TrendsPage() {
  const supabase = await createClient()

  // The household beside its timezone, and its banks beside the categories below: the bank list
  // the "isn't syncing" banner needs (#135) is two reads, and this way it adds no wait of its own.
  const [tz, householdId] = await Promise.all([householdTimezone(), currentHouseholdId()])
  // The household's day, not the server's: at 8pm US Eastern the server is already tomorrow, and
  // on the last evening of a month that moved this page forward a whole month early (#73).
  const windows = lastCompleteMonths(todayIn(tz))

  // Both throw on a failed read: with no categories a paycheck is charted as negative spending
  // under "Uncategorized", and with no banks every bank would look healthy. A failed read must not
  // become a plausible number, or a missing warning (#46).
  const [data, items] = await Promise.all([fetchCategoryContext(), listItemsForHousehold(householdId)])

  // Date-bounded at both ends. `previous.from` is the earliest date either card reads; the upper bound
  // is what stops a row dated beyond the window being fetched at all. `inRange` is what actually
  // enforces the windows — this only keeps the query from carrying rows nothing will use.
  // Paged, so a long window cannot silently pass the 1,000-row cap (#69).
  const { data: txns, error: txnsError } = await readAllRows(() =>
    supabase
      .from('transactions')
      .select(`id, amount, date, merchant_name, user_category, pfc_primary, pfc_detailed, reimbursable_amount, ${SUGGESTION_EMBED}`)
      .eq('removed', false)
      .gte('date', windows.previous.from)
      .lte('date', windows.current.to)
  )
  // #46's lesson: "the query failed" and "you spent nothing" must never render identically.
  if (txnsError) throw new Error(`could not read transactions: ${txnsError.message}`)

  // The reimbursable map is built straight from this page's own transaction rows — see
  // buildSpendContext.
  const list = withSuggestion(txns ?? [])
  const ctx = buildSpendContext({ data, txns: list })
  const view = trendsView(windows, list, ctx)

  return (
    <div className="space-y-6">
      <NotSyncingBanner items={items} />
      <PageHeader
        title="Trends"
        subtitle="Where your money went last month, and how that compares with the month before."
      />

      <Card className="p-5">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
          <h2 className="text-base font-semibold text-ink">Where the money went</h2>
          <span className="text-xs text-faint">{view.spend.label}</span>
        </div>
        <div className="mt-3">
          {view.spend.rows.length ? (
            <SpendByCategoryChart data={view.spend.rows} />
          ) : (
            <p className="text-sm text-muted">No spending recorded in {view.spend.label}.</p>
          )}
        </div>
      </Card>

      <Card className="p-5">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
          <h2 className="text-base font-semibold text-ink">Compared with the month before</h2>
          <span className="text-xs text-faint">{view.compare.label}</span>
        </div>
        <div className="mt-3">
          {view.compare.rows.length ? (
            <PeriodOverPeriodChart
              data={view.compare.rows}
              currentLabel={view.compare.currentLabel}
              previousLabel={view.compare.previousLabel}
            />
          ) : (
            <p className="text-sm text-muted">Not enough data yet to compare months.</p>
          )}
        </div>
      </Card>
    </div>
  )
}
