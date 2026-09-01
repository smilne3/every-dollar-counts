import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { BreakdownList, type BreakdownRow } from '@/components/BreakdownList'
import { PageHeader } from '@/components/ui/PageHeader'
import { Card } from '@/components/ui/Card'
import { groupAccountsByKind, sortedSpendRows } from '@/lib/breakdown'
import {
  netWorth,
  cashOnHand,
  lastNMonths,
  monthlyFlows,
  sumManualAssets,
  type FlowTxn,
} from '@/lib/dashboard'
import { listManualAssets } from '@/lib/manual-assets'
import { spendByCategory, monthKey, type Txn } from '@/lib/budget'
import { type Category } from '@/lib/categories'
import { buildSpendContext } from '@/lib/spend-context'
import { fetchReceivable } from '@/lib/receivable'

const TITLES: Record<string, { title: string; subtitle: string }> = {
  'net-worth': { title: 'Net worth', subtitle: 'Everything you own, minus what you owe' },
  cash: { title: 'Cash on hand', subtitle: 'Balances in your everyday accounts' },
  spent: { title: 'Spent this month', subtitle: 'Where the money went, by category' },
  saved: { title: 'Saved this month', subtitle: 'Money in versus money out' },
}

export default async function BreakdownPage({ params }: { params: Promise<{ metric: string }> }) {
  const { metric } = await params
  if (!TITLES[metric]) notFound()

  const supabase = await createClient()
  const { data: accountsData } = await supabase.from('accounts').select('*').order('name')
  const accounts = accountsData ?? []
  const currency = accounts[0]?.iso_currency_code ?? 'USD'

  // Manual assets (the home) count on the asset side of net worth, netting against the live mortgage.
  const { data: membershipRow } = await supabase
    .from('memberships')
    .select('household_id')
    .limit(1)
    .single()
  const manualAssets = membershipRow
    ? await listManualAssets(membershipRow.household_id)
    : []

  const header = TITLES[metric]
  let rows: BreakdownRow[] = []
  let total: { label: string; amount: number; currency: string } | undefined

  if (metric === 'net-worth') {
    const g = groupAccountsByKind(accounts)
    const accountRows: BreakdownRow[] = [...g.assets, ...g.liabilities].map((a) => ({
      key: a.id,
      label: a.name,
      sub: a.subtype,
      amount: a.balance,
      currency,
      owed: a.owed,
      href: `/transactions?account=${encodeURIComponent(a.account_id)}`,
    }))
    // Manual assets (the home) sit on the asset side; they have no transactions, so no drill link.
    const manualRows: BreakdownRow[] = manualAssets.map((a) => ({
      key: `manual-${a.id}`,
      label: a.name,
      sub: 'Manually entered',
      amount: a.value,
      currency,
      owed: false,
    }))
    // Money owed back is an asset: the cash has left the account but is coming back, so net worth
    // counts it (see fetchReceivable). It has no single transaction behind it, so it drills through
    // to the reimbursements page instead of a transaction list.
    const receivable = await fetchReceivable()
    const receivableRows: BreakdownRow[] =
      receivable > 0
        ? [
            {
              key: 'receivable',
              label: 'Owed to you',
              sub: 'Outstanding reimbursements',
              amount: receivable,
              currency,
              owed: false,
              href: '/reimbursements',
            },
          ]
        : []
    // Assets (accounts + manual + owed to you) first, then liabilities.
    rows = [
      ...accountRows.filter((r) => !r.owed),
      ...manualRows,
      ...receivableRows,
      ...accountRows.filter((r) => r.owed),
    ]
    total = {
      label: 'Net worth',
      // Must stay the same expression as the dashboard tile's, receivable included — a drill-down
      // whose rows do not add up to the number that was clicked is the bug this page exists to catch.
      amount: netWorth(accounts, receivable) + sumManualAssets(manualAssets),
      currency,
    }
  } else if (metric === 'cash') {
    // Cash = depository accounts only; reuse cashOnHand() for the total.
    const depository = accounts.filter((a) => a.type === 'depository')
    rows = depository.map((a) => ({
      key: a.id,
      label: a.name ?? 'Account',
      sub: a.subtype,
      amount: a.current_balance ?? 0,
      currency,
      href: `/transactions?account=${encodeURIComponent(a.account_id)}`,
    }))
    total = { label: 'Cash on hand', amount: cashOnHand(accounts), currency }
  } else {
    // spent / saved both need this month's flows
    const { data: cats } = await supabase
      .from('categories')
      .select('id, name, pfc_primary, sort_order')
      .order('sort_order')
    const categories = (cats ?? []) as Category[]

    const now = new Date()
    const months = lastNMonths(now, 6)
    const thisKey = months[months.length - 1].key
    const { data: flowTxns } = await supabase
      .from('transactions')
      .select('id, amount, date, user_category, pfc_primary, pfc_detailed, reimbursable_amount')
      .eq('removed', false)
      .gte('date', `${thisKey}-01`)

    // The reimbursable map is built straight from this page's own transaction rows — see
    // buildSpendContext.
    const ctx = buildSpendContext({ categories, txns: (flowTxns ?? []) as Txn[] })
    const allRows = (flowTxns ?? []) as Txn[]
    const monthTxns = allRows.filter((t) => monthKey(t.date) === thisKey)

    if (metric === 'spent') {
      const byCat = spendByCategory(monthTxns, ctx)
      rows = sortedSpendRows(byCat).map((r) => ({
        key: r.category,
        label: r.category,
        amount: r.amount,
        currency,
        href: `/transactions?category=${encodeURIComponent(r.category)}&month=${thisKey}`,
      }))
      const spent = rows.reduce((s, r) => s + r.amount, 0)
      total = { label: 'Total spent', amount: spent, currency }
    } else {
      // saved
      const flows = monthlyFlows(allRows as FlowTxn[], ctx, months)
      const m = flows[flows.length - 1]
      rows = [
        {
          key: 'in',
          label: 'Money in (income)',
          amount: m.income,
          currency,
          href: `/transactions?flow=in&month=${thisKey}`,
        },
        {
          key: 'out',
          label: 'Money out (spending)',
          amount: m.spending,
          currency,
          href: `/transactions?flow=out&month=${thisKey}`,
        },
      ]
      total = { label: 'Saved this month', amount: m.income - m.spending, currency }
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader title={header.title} subtitle={header.subtitle} />
      <Card className="p-5">
        <BreakdownList rows={rows} total={total} />
      </Card>
    </div>
  )
}
