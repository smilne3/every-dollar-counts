import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { AccountList } from '@/components/AccountList'
import { LinkButton } from '@/components/LinkButton'
import { RefreshButton } from '@/components/RefreshButton'
import { SpendIncomeChart } from '@/components/SpendIncomeChart'
import { RecentActivity } from '@/components/RecentActivity'
import { Card } from '@/components/ui/Card'
import { StatCard } from '@/components/ui/StatCard'
import { StatRows } from '@/components/ui/StatRows'
import { PageHeader } from '@/components/ui/PageHeader'
import { money, moneyWhole, longDate, monthNameLong } from '@/lib/format'
import { fetchCategoryContext } from '@/lib/category-context'
import { activityItem } from '@/lib/category-views'
import {
  netWorth,
  cashOnHand,
  lastNMonths,
  monthlyFlows,
  savedAverage,
  AVERAGE_SAVED_MONTHS,
  sumManualAssets,
} from '@/lib/dashboard'
import { listItemsForHousehold } from '@/lib/plaid-items'
import { listManualAssets } from '@/lib/manual-assets'
import { budgetedSpend, spendByCategory, monthKey } from '@/lib/budget'
import { buildSpendContext } from '@/lib/spend-context'
import { fetchReceivable } from '@/lib/receivable'
import { todayIn, hourIn } from '@/lib/clock'
import { householdTimezone } from '@/lib/household'
import { readAllRows } from '@/lib/read-all'
import { historyStart } from '@/lib/history-start'

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

  // Two different questions, two different sources. `now` is an INSTANT, and homeStale below
  // measures elapsed milliseconds between two instants — correct in any zone. `today` and the
  // greeting are CALENDAR values, which only mean anything in a stated zone (#73).
  const now = new Date()
  const tz = await householdTimezone()
  const today = todayIn(tz)
  const homeStale =
    home != null && now.getTime() - new Date(home.updated_at).getTime() > 30 * 24 * 60 * 60 * 1000
  const dateStr = longDate(today)

  if (accounts.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader title={greeting(hourIn(tz))} subtitle={dateStr} />
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

  // Throws on a failed read. With no categories nothing maps to Income or Transfer and a paycheck
  // counts as negative spending (measured: "Spent" -$1,796.70 against a true $3,929.35), so a
  // failure must not become a plausible number (#46).
  const data = await fetchCategoryContext()

  // The average's six complete months plus this one, which never counts toward it (#126). The
  // chart shows the last six of these ("Last 6 months" below), so AVERAGE_SAVED_MONTHS must not drop
  // below 6 without the chart changing too.
  const months = lastNMonths(today, AVERAGE_SAVED_MONTHS + 1)
  const windowStart = `${months[0].key}-01`

  // The window passes PostgREST's 1,000-row cap: six months alone held 908 rows on 2026-10-05, and
  // this reads seven. Paged, so the chart and the tiles never silently drop transactions (#69).
  const { data: flowTxns, error: flowError } = await readAllRows(() =>
    supabase
      .from('transactions')
      .select('id, amount, date, merchant_name, user_category, pfc_primary, pfc_detailed, reimbursable_amount')
      .eq('removed', false)
      .gte('date', windowStart)
  )
  // #46: "the query failed" and "you spent nothing this month" must never render identically.
  if (flowError) throw new Error(`could not read transactions: ${flowError.message}`)

  // Net worth DOES include this. A reimbursable expense takes the cash out of the account today and
  // brings it back later, so counting only the cash side would report money you are going to get
  // back as money you have lost. Fetched once here so it stays the single source of truth this tile
  // and its drill-down both point at — see fetchReceivable() in lib/receivable.ts.
  const owedToYou = await fetchReceivable()

  // The reimbursable map is built straight from this page's own transaction rows — see
  // buildSpendContext.
  const allRows = flowTxns ?? []
  const ctx = buildSpendContext({ data, txns: allRows })

  const flows = monthlyFlows(allRows, ctx, months)
  const thisMonth = flows[flows.length - 1]
  const spent = thisMonth.spending
  const income = thisMonth.income
  const saved = income - spent
  // Derived from the same key as the number beside it. These used to be computed independently,
  // so a partial fix could have had the label and the amount naming different months.
  const thisMonthLabel = monthNameLong(months[months.length - 1].key)
  const chartFlows = flows.slice(-6)
  const avgSaved = savedAverage(flows, months[months.length - 1].key, await historyStart())

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
    .select('id, name, merchant_name, amount, date, user_category, pfc_primary, pfc_detailed, reimbursable_amount')
    .eq('removed', false)
    .order('date', { ascending: false })
    .order('id', { ascending: false })  // #50: `date` is day-granular and ties constantly; without a unique second key Postgres may return tied rows in any order, so an UPDATE reshuffles the list under the reader.
    .limit(6)
  // Otherwise a failed read renders "No transactions yet" to a household with 696 of them.
  if (recentError) throw new Error(`could not read recent transactions: ${recentError.message}`)
  const recentItems = (recentTxns ?? []).map((t) => activityItem(t, ctx))

  const worth = netWorth(accounts, owedToYou) + sumManualAssets(manualAssets)
  const cash = cashOnHand(accounts)
  const depCount = accounts.filter((a) => a.type === 'depository').length

  const budgetPct = totalBudget > 0 ? Math.round((trackedSpend / totalBudget) * 100) : null
  // Exact on the tile; whole dollars on the phone row, beside a whole-dollar figure, so it fits.
  const budgetFoot = (fmt: typeof money) =>
    budgetPct != null ? (
      <span className={budgetPct > 100 ? 'text-coral' : budgetPct > 80 ? 'text-amber' : 'text-muted'}>
        {`${fmt(trackedSpend, currency)} of ${fmt(totalBudget, currency)} budgeted`}
      </span>
    ) : (
      <span className="text-muted">this month</span>
    )

  const cashFoot = (
    <span className="text-muted">
      In {depCount} account{depCount === 1 ? '' : 's'}
    </span>
  )
  // No average line when there is no figure (the phone row shows money in and out instead):
  // neither layout has room to say why, and the saved breakdown it links to does. The month count keeps a one- or two-month "average" from passing for a
  // settled one. Coral by the rounded figure, so a few cents below zero does not read as a red "$0".
  const avgLine =
    avgSaved.kind === 'average' ? (
      <span className={`block ${Math.round(avgSaved.average) < 0 ? 'text-coral' : 'text-muted'}`}>
        {`Avg ${moneyWhole(avgSaved.average, currency)}/mo · ${avgSaved.months.length} mo`}
      </span>
    ) : null

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
        title={greeting(hourIn(tz))}
        subtitle={`${dateStr} — here's where your money stands`}
        actions={
          <>
            <RefreshButton />
            <LinkButton />
          </>
        }
      />

      {/* Net worth leads (§4). Below `md` it is a full-width hero with the other three as rows in
          one card beneath it (StatRows); from `md` up this is the grid it has always been —
          two-across at `md`, four at `lg`. The hero sits outside the rows because only from `md` up
          do they share one grid. */}
      <div className="space-y-4 md:grid md:grid-cols-2 md:gap-4 md:space-y-0 lg:grid-cols-4">
        <StatCard
          label="Net worth"
          amount={worth}
          currency={currency}
          variant="hero"
          href="/breakdown/net-worth"
          foot={
            <span className="text-muted">
              Across {accounts.length} account{accounts.length === 1 ? '' : 's'}
            </span>
          }
        />
        {/* The three supporting figures. On a phone, rows in one card: three tiles across were too
            narrow (see components/ui/StatRows.tsx). The Saved row has room for one note: the
            average when there is one, which drops money in and out, otherwise money in and out in
            whole dollars. */}
        <div className="md:hidden">
          <StatRows
            rows={[
              { label: 'Cash on hand', amount: cash, currency, href: '/breakdown/cash', foot: cashFoot },
              {
                label: `Spent in ${thisMonthLabel}`,
                amount: spent,
                currency,
                href: '/breakdown/spent',
                foot: budgetFoot(moneyWhole),
              },
              {
                label: 'Saved this month',
                amount: saved,
                currency,
                href: '/breakdown/saved',
                tone: saved < 0 ? 'coral' : 'ink',
                foot: avgLine ?? `${moneyWhole(income, currency)} in · ${moneyWhole(spent, currency)} out`,
              },
            ]}
          />
        </div>
        {/* From `md` up, tiles. `contents` so they become direct children of the grid above and take
            their own tracks, rather than sitting inside a nested box. */}
        <div className="hidden md:contents">
          <StatCard
            label="Cash on hand"
            amount={cash}
            currency={currency}
            variant="compact"
            href="/breakdown/cash"
            foot={cashFoot}
          />
          <StatCard
            label={`Spent in ${thisMonthLabel}`}
            amount={spent}
            currency={currency}
            variant="compact"
            href="/breakdown/spent"
            foot={budgetFoot(money)}
          />
          <StatCard
            label="Saved this month"
            amount={saved}
            currency={currency}
            variant="compact"
            tone={saved < 0 ? 'coral' : 'ink'}
            href="/breakdown/saved"
            foot={
              <>
                <span className="text-muted">
                  {money(income, currency)} in · {money(spent, currency)} out
                </span>
                {avgLine}
              </>
            }
          />
        </div>
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
            <SpendIncomeChart data={chartFlows} />
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
        <AccountList accounts={accounts} />
      </div>
    </div>
  )
}
