import { createClient } from '@/lib/supabase/server'
import { spendByCategory, spendThisVsLast, monthKey } from '@/lib/budget'
import { type Category } from '@/lib/categories'
import { buildSpendContext } from '@/lib/spend-context'
import { writeOffsAsTxns, type Split, type WriteOff } from '@/lib/reimbursements'
import { SpendByCategoryChart } from '@/components/SpendByCategoryChart'
import { MonthOverMonthChart } from '@/components/MonthOverMonthChart'
import { Card } from '@/components/ui/Card'
import { PageHeader } from '@/components/ui/PageHeader'

export default async function TrendsPage() {
  const supabase = await createClient()

  const now = new Date()
  const thisM = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const lastDate = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  const lastM = `${lastDate.getFullYear()}-${String(lastDate.getMonth() + 1).padStart(2, '0')}`

  const { data: cats } = await supabase
    .from('categories')
    .select('id, name, pfc_primary, sort_order')
    .order('sort_order')
  const categories = (cats ?? []) as Category[]

  const { data: txns } = await supabase
    .from('transactions')
    .select('id, amount, date, user_category, pfc_primary, pfc_detailed')
    .eq('removed', false)
    .gte('date', `${lastM}-01`)

  const { data: splitRows } = await supabase
    .from('reimbursement_splits')
    .select('transaction_id, claim_id, owed_by, amount')
  const { data: writeOffRows } = await supabase
    .from('reimbursement_write_offs')
    .select('claim_id, category, amount, date')
    .gte('date', `${lastM}-01`)

  const ctx = buildSpendContext({ categories, splits: (splitRows ?? []) as Split[] })
  // A written-off claim is spending in the month it was written off, so it joins the list here.
  const list = [...(txns ?? []), ...writeOffsAsTxns((writeOffRows ?? []) as WriteOff[])]

  const byCat = spendByCategory(
    list.filter((t) => monthKey(t.date) === thisM),
    ctx
  )
  const spendData = Object.entries(byCat)
    .map(([category, amount]) => ({ category, amount }))
    .sort((a, b) => b.amount - a.amount)

  // Cap last month at today's day-of-month so the comparison is fair mid-month (#9).
  const throughDay = now.getDate()
  const { thisMonth, lastMonth } = spendThisVsLast(
    list,
    thisM,
    lastM,
    ctx,
    throughDay
  )
  const names = Array.from(new Set([...Object.keys(thisMonth), ...Object.keys(lastMonth)]))
  const momData = names
    .map((category) => ({
      category,
      thisMonth: thisMonth[category] ?? 0,
      lastMonth: lastMonth[category] ?? 0,
    }))
    .sort((a, b) => b.thisMonth + b.lastMonth - (a.thisMonth + a.lastMonth))

  const monthLabel = new Intl.DateTimeFormat('en-US', { month: 'long' }).format(now)
  const lastMonthLabel = new Intl.DateTimeFormat('en-US', { month: 'long' }).format(lastDate)

  return (
    <div className="space-y-6">
      <PageHeader title="Trends" subtitle="Where your money goes, and how this month compares." />

      <Card className="p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-ink">Where the money went</h2>
          <span className="text-xs text-faint">{monthLabel}</span>
        </div>
        <div className="mt-3">
          {spendData.length ? (
            <SpendByCategoryChart data={spendData} />
          ) : (
            <p className="text-sm text-muted">No spending recorded this month yet.</p>
          )}
        </div>
      </Card>

      <Card className="p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-ink">This month vs last</h2>
          <span className="text-xs text-faint">
            {monthLabel} vs {lastMonthLabel}, through day {throughDay}
          </span>
        </div>
        <div className="mt-3">
          {momData.length ? (
            <MonthOverMonthChart data={momData} />
          ) : (
            <p className="text-sm text-muted">Not enough data yet to compare months.</p>
          )}
        </div>
      </Card>
    </div>
  )
}
