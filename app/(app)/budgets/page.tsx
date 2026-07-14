import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { spendByCategory } from '@/lib/budget'
import { pfcToName, spendingCategoryNames, nonSpendingNames, type Category } from '@/lib/categories'
import { BudgetEditor } from '@/components/BudgetEditor'
import { PageHeader } from '@/components/ui/PageHeader'
import { buttonClass } from '@/components/ui/Button'

export default async function BudgetsPage() {
  const supabase = await createClient()

  const now = new Date()
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`
  const next = new Date(now.getFullYear(), now.getMonth() + 1, 1)
  const nextMonthStart = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-01`

  const { data: cats } = await supabase
    .from('categories')
    .select('id, name, pfc_primary, sort_order')
    .order('sort_order')
  const categories = (cats ?? []) as Category[]
  const pfcMap = pfcToName(categories)
  const nonSpending = nonSpendingNames(categories)
  const categoryNames = spendingCategoryNames(categories)

  const { data: txns } = await supabase
    .from('transactions')
    .select('amount, date, user_category, pfc_primary')
    .eq('removed', false)
    .gte('date', monthStart)
    .lt('date', nextMonthStart)
  const { data: budgets } = await supabase.from('budgets').select('category, monthly_limit')

  const spend = spendByCategory(txns ?? [], pfcMap, nonSpending)
  const initialLimits: Record<string, number> = {}
  for (const b of budgets ?? []) initialLimits[b.category] = Number(b.monthly_limit)

  return (
    <div className="space-y-6">
      <PageHeader
        title="Budgets"
        subtitle="Set a monthly limit per category — bars show this month's spending against each."
        actions={
          <Link href="/settings" className={buttonClass('secondary', 'md')}>
            Add / rename categories
          </Link>
        }
      />
      <p className="text-sm text-muted">
        To rename a category or add your own, use{' '}
        <Link href="/settings" className="text-emerald hover:text-emerald-600">
          Settings → Categories
        </Link>
        .
      </p>
      <BudgetEditor categoryNames={categoryNames} initialLimits={initialLimits} spend={spend} />
    </div>
  )
}
