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
import { listItemsForHousehold } from '@/lib/plaid-items'
import { budgetedSpend, spendByCategory, monthKey, type Txn } from '@/lib/budget'

function greeting(hour: number): string {
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

export default async function DashboardPage() {
  const supabase = await createClient()
  const { data: accountsData } = await supabase.from('accounts').select('*').order('name')
  const accounts = accountsData ?? []

  // Any bank that isn't syncing has to be visible on the main screen. Stale numbers that look
  // fine are the failure this whole migration exists to prevent.
  const { data: membershipRow } = await supabase
    .from('memberships')
    .select('household_id')
    .limit(1)
    .single()
  const items = membershipRow ? await listItemsForHousehold(membershipRow.household_id) : []
  const unhealthy = items.filter((i) => i.status !== 'ok')
  const needsReconnect = unhealthy.some((i) => i.status === 'needs_reconnect')

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

  const { data: budgetRows } = await supabase.from('budgets').select('category, monthly_limit')
  const limits: Record<string, number> = {}
  for (const b of budgetRows ?? []) limits[b.category as string] = Number(b.monthly_limit || 0)
  const totalBudget = Object.values(limits).reduce((s, v) => s + v, 0)

  // Only spend in budgeted categories counts against the budget total — see budgetedSpend.
  const thisMonthKey = months[months.length - 1].key
  const monthTxns = ((flowTxns ?? []) as Txn[]).filter((t) => monthKey(t.date) === thisMonthKey)
  const trackedSpend = budgetedSpend(spendByCategory(monthTxns, pfcMap, nonSpending), limits)

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

  const budgetPct = totalBudget > 0 ? Math.round((trackedSpend / totalBudget) * 100) : null
  const budgetFoot =
    budgetPct != null ? (
      <span className={budgetPct > 100 ? 'text-coral' : budgetPct > 80 ? 'text-amber' : 'text-muted'}>
        {money(trackedSpend, currency)} of {money(totalBudget, currency)} budgeted
      </span>
    ) : (
      <span className="text-muted">this month</span>
    )

  return (
    <div className="space-y-6">
      {unhealthy.length > 0 && (
        <Link
          href="/settings"
          className="block rounded-card border border-coral/40 bg-coral/10 px-4 py-3 text-sm text-coral"
        >
          {unhealthy.length === 1
            ? `${unhealthy[0].institution_name ?? 'A bank'} isn't syncing`
            : `${unhealthy.length} banks aren't syncing`}
          {needsReconnect
            ? ' — reconnect in Settings to resume. These figures may be out of date.'
            : ' — see Settings. These figures may be out of date.'}
        </Link>
      )}

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

      {/* grid-cols-1 (= minmax(0,1fr)), not a bare `grid`: an implicit auto track sizes to
          max-content, so the chart's intrinsic width scrolls the whole page sideways on a
          phone. min-w-0 on the card alone does not help — the track is what grows. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="min-w-0 p-5 lg:col-span-2">
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
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {accounts.map((a) => (
            <AccountCard key={a.id} account={a} />
          ))}
        </div>
      </div>
    </div>
  )
}
