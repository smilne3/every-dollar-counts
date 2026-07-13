import { createClient } from '@/lib/supabase/server'
import { spendByCategory } from '@/lib/budget'
import { BudgetEditor } from '@/components/BudgetEditor'

export default async function BudgetsPage() {
  const supabase = await createClient()

  const now = new Date()
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`

  const { data: txns } = await supabase
    .from('transactions')
    .select('amount, date, user_category, pfc_primary')
    .eq('removed', false)
    .gte('date', monthStart)
  const { data: budgets } = await supabase.from('budgets').select('category, monthly_limit')

  const spend = spendByCategory(txns ?? [])
  const initialLimits: Record<string, number> = {}
  for (const b of budgets ?? []) initialLimits[b.category] = Number(b.monthly_limit)

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Budgets</h1>
      <p className="text-sm text-gray-600">
        Set a monthly limit per category. Bars show this month&apos;s spending against each limit.
      </p>
      <BudgetEditor initialLimits={initialLimits} spend={spend} />
    </div>
  )
}
