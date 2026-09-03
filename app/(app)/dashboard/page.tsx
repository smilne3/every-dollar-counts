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
import { isCreditCardPayment } from '@/lib/categories'
import { pfcToName, type Category } from '@/lib/categories'
import {
  netWorth,
  cashOnHand,
  lastNMonths,
  monthlyFlows,
  sumManualAssets,
  type FlowTxn,
} from '@/lib/dashboard'
import { listItemsForHousehold } from '@/lib/plaid-items'
import { listManualAssets } from '@/lib/manual-assets'
import { budgetedSpend, spendByCategory, monthKey, type Txn } from '@/lib/budget'
import { buildSpendContext } from '@/lib/spend-context'
import { fetchReceivable } from '@/lib/receivable'

function greeting(hour: number): string {
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string }>
}) {
  // A one-time note carried over from the OAuth return (e.g. "connected, transactions still
  // arriving") so it isn't lost on the redirect. Next 16: searchParams is async.
  const notice = (await searchParams)?.notice
  const supabase = await createClient()
  const { data: accountsData, error: accountsError } = await supabase
    .from('accounts')
    .select('*')
    .order('name')
    .order('account_id')
  // Zero accounts renders "Connect your first account". A household with eleven of them being told
  // it has none is not a smaller failure than an error message, it is a more convincing one (#46).
  if (accountsError) throw new Error(`could not read accounts: ${accountsError.message}`)
  const accounts = accountsData ?? []

  // Any bank that isn't syncing has to be visible on the main screen. Stale numbers that look
  // fine are the failure this whole migration exists to prevent.
  const { data: membershipRow, error: membershipError } = await supabase
    .from('memberships')
    .select('household_id')
    .limit(1)
    .single()
  // Without this, the banks list and the home value both silently vanish, and net worth quietly
  // drops by the value of the house.
  if (membershipError) throw new Error(`could not read your household: ${membershipError.message}`)
  const items = membershipRow ? await listItemsForHousehold(membershipRow.household_id) : []
  const manualAssets = membershipRow ? await listManualAssets(membershipRow.household_id) : []
  const home = manualAssets.find((a) => a.name === 'Home') ?? null
  const unhealthy = items.filter((i) => i.status !== 'ok')
  const needsReconnect = unhealthy.some((i) => i.status === 'needs_reconnect')

  const now = new Date()
  const homeStale =
    home != null && now.getTime() - new Date(home.updated_at).getTime() > 30 * 24 * 60 * 60 * 1000
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

  const { data: catsData, error: catsError } = await supabase
    .from('categories')
    .select('id, name, pfc_primary, sort_order')
    .order('sort_order')
  // The sharpest one on this page. With no categories nothing maps to Income or Transfer, so the
  // exclusions in monthlyFlows never fire and a paycheck is counted as negative spending: measured
  // on real rows, "Spent" reads -$1,796.70 and "Saved" +$1,796.70 where the truth is $3,929.35 and
  // $1,796.70. A failed read must not become a plausible number (#46).
  if (catsError) throw new Error(`could not read categories: ${catsError.message}`)
  const categories = (catsData ?? []) as Category[]
  const pfcMap = pfcToName(categories)

  const months = lastNMonths(now, 6)
  const sixStart = `${months[0].key}-01`

  const { data: flowTxns, error: flowError } = await supabase
    .from('transactions')
    .select('id, amount, date, user_category, pfc_primary, pfc_detailed, reimbursable_amount')
    .eq('removed', false)
    .gte('date', sixStart)
  // #46: "the query failed" and "you spent nothing this month" must never render identically.
  if (flowError) throw new Error(`could not read transactions: ${flowError.message}`)

  // Net worth DOES include this. A reimbursable expense takes the cash out of the account today and
  // brings it back later, so counting only the cash side would report money you are going to get
  // back as money you have lost. Fetched once here so it stays the single source of truth this tile
  // and its drill-down both point at — see fetchReceivable() in lib/receivable.ts.
  const owedToYou = await fetchReceivable()

  // The reimbursable map is built straight from this page's own transaction rows — see
  // buildSpendContext.
  const ctx = buildSpendContext({ categories, txns: (flowTxns ?? []) as Txn[] })
  const allRows = (flowTxns ?? []) as Txn[]

  const flows = monthlyFlows(allRows as FlowTxn[], ctx, months)
  const thisMonth = flows[flows.length - 1]
  const spent = thisMonth.spending
  const income = thisMonth.income
  const saved = income - spent
  const thisMonthLabel = new Intl.DateTimeFormat('en-US', { month: 'long' }).format(now)

  const { data: budgetRows, error: budgetsError } = await supabase
    .from('budgets')
    .select('category, monthly_limit')
  // A failed read here reads as "you have not set any budgets", so the tile's budget footnote
  // disappears rather than reporting that it could not be worked out.
  if (budgetsError) throw new Error(`could not read budgets: ${budgetsError.message}`)
  const limits: Record<string, number> = {}
  for (const b of budgetRows ?? []) limits[b.category as string] = Number(b.monthly_limit || 0)
  const totalBudget = Object.values(limits).reduce((s, v) => s + v, 0)

  // Only spend in budgeted categories counts against the budget total — see budgetedSpend.
  const thisMonthKey = months[months.length - 1].key
  const monthTxns = allRows.filter((t) => monthKey(t.date) === thisMonthKey)
  const trackedSpend = budgetedSpend(spendByCategory(monthTxns, ctx), limits)

  const { data: recentTxns, error: recentError } = await supabase
    .from('transactions')
    .select('id, name, merchant_name, amount, date, user_category, pfc_primary, pfc_detailed')
    .eq('removed', false)
    .order('date', { ascending: false })
    .order('id', { ascending: false })  // #50: `date` is day-granular and ties constantly; without a unique second key Postgres may return tied rows in any order, so an UPDATE reshuffles the list under the reader.
    .limit(6)
  // Otherwise a failed read renders "No transactions yet" to a household with 696 of them.
  if (recentError) throw new Error(`could not read recent transactions: ${recentError.message}`)
  const recentItems = (recentTxns ?? []).map((t) => ({
    id: t.id as string,
    name: (t.merchant_name ?? t.name ?? 'Transaction') as string,
    category: effectiveCategory(t, pfcMap),
    date: t.date as string,
    amount: t.amount as number,
    // Recent activity paints inflows emerald with a leading '+'. On the leg that credits the card
    // that reads as income arriving, which it is not (#31 already keeps both legs out of every
    // total). The list needs to be told, so pfc_detailed is selected above for this alone.
    internalTransfer: isCreditCardPayment(t),
  }))

  const worth = netWorth(accounts, owedToYou) + sumManualAssets(manualAssets)
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
      {notice && (
        <div className="rounded-card border border-emerald/30 bg-emerald-050 px-4 py-3 text-sm text-emerald-600">
          {notice}
        </div>
      )}

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

      {homeStale && (
        <Link
          href="/settings"
          className="block rounded-card border border-amber/40 bg-amber/10 px-4 py-3 text-sm text-amber"
        >
          Your home value was last updated over a month ago — check Zillow and update it in Settings.
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
          href="/breakdown/net-worth"
          foot={
            <span className="text-muted">
              Across {accounts.length} account{accounts.length === 1 ? '' : 's'}
            </span>
          }
        />
        <StatCard
          label="Cash on hand"
          value={money(cash, currency)}
          href="/breakdown/cash"
          foot={
            <span className="text-muted">
              In {depCount} account{depCount === 1 ? '' : 's'}
            </span>
          }
        />
        <StatCard
          label={`Spent in ${thisMonthLabel}`}
          value={money(spent, currency)}
          href="/breakdown/spent"
          foot={budgetFoot}
        />
        <StatCard
          label="Saved this month"
          value={<span className={saved < 0 ? 'text-coral' : 'text-ink'}>{money(saved, currency)}</span>}
          href="/breakdown/saved"
          foot={
            <span className="text-muted">
              {money(income, currency)} in · {money(spent, currency)} out
            </span>
          }
        />
      </div>

      {owedToYou > 0 && (
        <Link
          href="/reimbursements"
          aria-label={`Owed to you: ${money(owedToYou, currency)}`}
          className="flex items-center justify-between rounded-lg border border-line px-4 py-3 text-sm hover:bg-surface-2"
        >
          <span className="text-muted">Owed to you</span>
          <span className="font-medium tabular-nums text-ink">{money(owedToYou, currency)}</span>
        </Link>
      )}

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
