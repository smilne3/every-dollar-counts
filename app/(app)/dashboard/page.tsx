import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { AccountCard } from '@/components/AccountCard'
import { LinkButton } from '@/components/LinkButton'
import { RefreshButton } from '@/components/RefreshButton'
import { SpendIncomeChart } from '@/components/SpendIncomeChart'
import { RecentActivity } from '@/components/RecentActivity'
import { Card } from '@/components/ui/Card'
import { StatCard } from '@/components/ui/StatCard'
import { PageHeader } from '@/components/ui/PageHeader'
import { money } from '@/lib/format'
import { effectiveCategory } from '@/lib/effective-category'
import { pfcToName, nonSpendingNames, transferNames, type Category } from '@/lib/categories'
import { netWorth, cashOnHand, lastNMonths, monthlyFlows, type FlowTxn } from '@/lib/dashboard'

function greeting(hour: number): string {
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

export default async function DashboardPage() {
  const supabase = await createClient()
  const { data: accountsData } = await supabase.from('accounts').select('*').order('name')
  const accounts = accountsData ?? []

  const now = new Date()
  const dateStr = new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(now)

  if (accounts.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader title={greeting(now.getHours())} subtitle={dateStr} />
        <Card className="p-8 text-center">
          <h2 className="text-lg font-semibold text-ink">Connect your first account</h2>
          <p className="mx-auto mt-1 max-w-sm text-sm text-muted">
            Link a bank to see your balances, spending, and savings goals all in one place.
          </p>
          <div className="mt-5 flex justify-center">
            <LinkButton />
          </div>
        </Card>
      </div>
    )
  }

  const currency = accounts[0]?.iso_currency_code ?? 'USD'

  const { data: catsData } = await supabase
    .from('categories')
    .select('id, name, pfc_primary, sort_order')
    .order('sort_order')
  const categories = (catsData ?? []) as Category[]
  const pfcMap = pfcToName(categories)
  const nonSpending = nonSpendingNames(categories)
  const transfers = transferNames(categories)

  const months = lastNMonths(now, 6)
  const sixStart = `${months[0].key}-01`

  const { data: flowTxns } = await supabase
    .from('transactions')
    .select('amount, date, user_category, pfc_primary')
    .eq('removed', false)
    .gte('date', sixStart)
  const flows = monthlyFlows((flowTxns ?? []) as FlowTxn[], pfcMap, nonSpending, transfers, months)
  const thisMonth = flows[flows.length - 1]
  const spent = thisMonth.spending
  const income = thisMonth.income
  const saved = income - spent
  const thisMonthLabel = new Intl.DateTimeFormat('en-US', { month: 'long' }).format(now)

  const { data: budgetRows } = await supabase.from('budgets').select('monthly_limit')
  const totalBudget = (budgetRows ?? []).reduce((s, b) => s + Number(b.monthly_limit || 0), 0)

  const { data: recentTxns } = await supabase
    .from('transactions')
    .select('id, name, merchant_name, amount, date, user_category, pfc_primary')
    .eq('removed', false)
    .order('date', { ascending: false })
    .limit(6)
  const recentItems = (recentTxns ?? []).map((t) => ({
    id: t.id as string,
    name: (t.merchant_name ?? t.name ?? 'Transaction') as string,
    category: effectiveCategory(t, pfcMap),
    date: t.date as string,
    amount: t.amount as number,
  }))

  const worth = netWorth(accounts)
  const cash = cashOnHand(accounts)
  const depCount = accounts.filter((a) => a.type === 'depository').length

  const budgetPct = totalBudget > 0 ? Math.round((spent / totalBudget) * 100) : null
  const budgetFoot =
    budgetPct != null ? (
      <span className={budgetPct > 100 ? 'text-coral' : budgetPct > 80 ? 'text-amber' : 'text-muted'}>
        {budgetPct}% of {money(totalBudget, currency)} budget
      </span>
    ) : (
      <span className="text-muted">this month</span>
    )

  return (
    <div className="space-y-6">
      <PageHeader
        title={greeting(now.getHours())}
        subtitle={`${dateStr} — here's where your money stands`}
        actions={
          <>
            <RefreshButton />
            <LinkButton />
          </>
        }
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          label="Net worth"
          value={money(worth, currency)}
          foot={
            <span className="text-muted">
              Across {accounts.length} account{accounts.length === 1 ? '' : 's'}
            </span>
          }
        />
        <StatCard
          label="Cash on hand"
          value={money(cash, currency)}
          foot={
            <span className="text-muted">
              In {depCount} account{depCount === 1 ? '' : 's'}
            </span>
          }
        />
        <StatCard label={`Spent in ${thisMonthLabel}`} value={money(spent, currency)} foot={budgetFoot} />
        <StatCard
          label="Saved this month"
          value={<span className={saved < 0 ? 'text-coral' : 'text-ink'}>{money(saved, currency)}</span>}
          foot={
            <span className="text-muted">
              {money(income, currency)} in · {money(spent, currency)} out
            </span>
          }
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="p-5 lg:col-span-2">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-ink">Spending vs income</h2>
            <span className="text-xs text-faint">Last 6 months</span>
          </div>
          <div className="mt-3">
            <SpendIncomeChart data={flows} />
          </div>
        </Card>

        <Card className="p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-ink">Recent activity</h2>
            <Link
              href="/transactions"
              className="text-xs font-medium text-emerald hover:text-emerald-600"
            >
              View all
            </Link>
          </div>
          <div className="mt-3">
            <RecentActivity items={recentItems} />
          </div>
        </Card>
      </div>

      <div className="space-y-3">
        <h2 className="text-base font-semibold text-ink">Accounts</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {accounts.map((a) => (
            <AccountCard key={a.id} account={a} />
          ))}
        </div>
      </div>
    </div>
  )
}
