import { createClient } from '@/lib/supabase/server'
import { lastCompleteMonths, type Txn } from '@/lib/budget'
import { trendsView } from '@/lib/trends'
import { type Category } from '@/lib/categories'
import { buildSpendContext } from '@/lib/spend-context'
import { SpendByCategoryChart } from '@/components/SpendByCategoryChart'
import { PeriodOverPeriodChart } from '@/components/PeriodOverPeriodChart'
import { Card } from '@/components/ui/Card'
import { PageHeader } from '@/components/ui/PageHeader'

// Trends reports the last month that has FINISHED; Budgets reports the calendar month so far.
// That is the whole of #67: a month still in progress is, for its first fortnight, almost
// entirely the mortgage — true, unchanging, and not what anyone opened this page to learn.
//
// The two pages therefore answer different questions on purpose — "where does my money go"
// against "am I on track this month" — so every label here names its month outright, and the page
// deliberately says nothing about the month you are currently in.
export default async function TrendsPage() {
  const supabase = await createClient()

  const windows = lastCompleteMonths(new Date())

  const { data: cats, error: catsError } = await supabase
    .from('categories')
    .select('id, name, pfc_primary, sort_order')
    .order('sort_order')
  // Not merely cosmetic: with no categories, nothing maps to Income or Transfer, so the exclusions
  // in spendByCategory never fire and a paycheck is charted as negative spending under
  // "Uncategorized". A failed read must not become a plausible number (#46).
  if (catsError) throw new Error(`could not read categories: ${catsError.message}`)
  const categories = (cats ?? []) as Category[]

  // Bounded at both ends. `previous.from` is the earliest date either card reads; the upper bound
  // is what stops a row dated beyond the window being fetched at all. `inRange` is what actually
  // enforces the windows — this only keeps the query from carrying rows nothing will use.
  const { data: txns, error: txnsError } = await supabase
    .from('transactions')
    .select('id, amount, date, user_category, pfc_primary, pfc_detailed, reimbursable_amount')
    .eq('removed', false)
    .gte('date', windows.previous.from)
    .lte('date', windows.current.to)
  // #46's lesson: "the query failed" and "you spent nothing" must never render identically.
  if (txnsError) throw new Error(`could not read transactions: ${txnsError.message}`)

  // The reimbursable map is built straight from this page's own transaction rows — see
  // buildSpendContext.
  const list = (txns ?? []) as Txn[]
  const ctx = buildSpendContext({ categories, txns: list })
  const view = trendsView(windows, list, ctx)

  return (
    <div className="space-y-6">
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
