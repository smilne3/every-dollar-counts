import { createClient } from '@/lib/supabase/server'
import { spendByCategory, spendThisVsLast, monthKey } from '@/lib/budget'
import { SpendByCategoryChart } from '@/components/SpendByCategoryChart'
import { MonthOverMonthChart } from '@/components/MonthOverMonthChart'

export default async function TrendsPage() {
  const supabase = await createClient()

  const now = new Date()
  const thisM = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const lastDate = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  const lastM = `${lastDate.getFullYear()}-${String(lastDate.getMonth() + 1).padStart(2, '0')}`

  const { data: txns } = await supabase
    .from('transactions')
    .select('amount, date, user_category, pfc_primary')
    .eq('removed', false)
    .gte('date', `${lastM}-01`)
  const list = txns ?? []

  const byCat = spendByCategory(list.filter((t) => monthKey(t.date) === thisM))
  const spendData = Object.entries(byCat)
    .map(([category, amount]) => ({ category, amount }))
    .sort((a, b) => b.amount - a.amount)

  const { thisMonth, lastMonth } = spendThisVsLast(list, thisM, lastM)
  const cats = Array.from(new Set([...Object.keys(thisMonth), ...Object.keys(lastMonth)]))
  const momData = cats
    .map((category) => ({
      category,
      thisMonth: thisMonth[category] ?? 0,
      lastMonth: lastMonth[category] ?? 0,
    }))
    .sort((a, b) => b.thisMonth + b.lastMonth - (a.thisMonth + a.lastMonth))

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-semibold">Trends</h1>

      <section>
        <h2 className="mb-2 text-lg font-medium">Where the money went this month</h2>
        {spendData.length ? (
          <SpendByCategoryChart data={spendData} />
        ) : (
          <p className="text-gray-600">No spending recorded this month yet.</p>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-lg font-medium">This month vs last</h2>
        {momData.length ? (
          <MonthOverMonthChart data={momData} />
        ) : (
          <p className="text-gray-600">Not enough data yet to compare months.</p>
        )}
      </section>
    </div>
  )
}
