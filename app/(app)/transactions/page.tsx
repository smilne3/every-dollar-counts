import { createClient } from '@/lib/supabase/server'
import { TransactionRow } from '@/components/TransactionRow'
import { Card } from '@/components/ui/Card'
import { PageHeader } from '@/components/ui/PageHeader'
import { Button } from '@/components/ui/Button'
import { SearchIcon } from '@/components/ui/icons'
import { inputClass } from '@/components/ui/styles'
import { effectiveCategory } from '@/lib/effective-category'
import {
  pfcToName,
  nonSpendingNames,
  transferNames,
  isCreditCardPayment,
  type Category,
} from '@/lib/categories'

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string
    account?: string
    category?: string
    month?: string
    flow?: string
  }>
}) {
  const { q, account, category, month, flow } = await searchParams
  const safe = (q ?? '').replace(/[,()%*]/g, ' ').trim()

  const supabase = await createClient()
  const { data: cats } = await supabase
    .from('categories')
    .select('id, name, pfc_primary, sort_order')
    .order('sort_order')
  const categories = (cats ?? []) as Category[]
  const pfcMap = pfcToName(categories)
  const categoryOptions = categories.map((c) => c.name)

  // Only needed to name the account in the filter chip when drilling in from a Net Worth / Cash row.
  let accountName: string | null = null
  if (account) {
    const { data: acct } = await supabase
      .from('accounts')
      .select('name')
      .eq('account_id', account)
      .maybeSingle()
    accountName = acct?.name ?? null
  }

  let query = supabase
    .from('transactions')
    .select('id, name, merchant_name, amount, date, user_category, pfc_primary, pfc_detailed, account_id')
    .eq('removed', false)
    .order('date', { ascending: false })
    .limit(200)
  if (safe) query = query.or(`name.ilike.%${safe}%,merchant_name.ilike.%${safe}%`)
  // Account and month are plain columns — filter in SQL.
  if (account) query = query.eq('account_id', account)
  if (month) {
    const [y, m] = month.split('-').map(Number)
    const start = `${month}-01`
    const nextY = m === 12 ? y + 1 : y
    const nextM = m === 12 ? 1 : m + 1
    const end = `${nextY}-${String(nextM).padStart(2, '0')}-01`
    query = query.gte('date', start).lt('date', end)
  }
  const { data: txns } = await query
  let list = txns ?? []

  // Category and flow are on the transaction's EFFECTIVE category (computed), so filter in memory.
  if (category) {
    list = list.filter((t) => effectiveCategory(t, pfcMap) === category)
  }
  if (flow === 'in' || flow === 'out') {
    const nonSpending = nonSpendingNames(categories) // income + transfers
    const transfers = transferNames(categories)
    list = list.filter((t) => {
      if (isCreditCardPayment(t)) return false
      const cat = effectiveCategory(t, pfcMap)
      if (transfers.has(cat)) return false
      const isIncomeCat = nonSpending.has(cat) && !transfers.has(cat)
      // Money in must be an actual inflow in an income category — matching monthlyFlows, which only
      // counts amount < 0 toward income. Without the sign guard, an income-category *outflow*
      // (a clawback, or a user-overridden row) would show here but never appear in the income total,
      // so the list wouldn't reconcile with the "Money in" figure it drills from.
      return flow === 'in' ? isIncomeCat && t.amount < 0 : !isIncomeCat
    })
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Transactions"
        subtitle="Search and re-categorize your spending."
        actions={
          <form className="flex items-center gap-2">
            {/* Carry the active drill-down filters through a search submit; a GET form only sends
                its own controls, so without these, searching would silently drop the drill context. */}
            {account && <input type="hidden" name="account" value={account} />}
            {category && <input type="hidden" name="category" value={category} />}
            {month && <input type="hidden" name="month" value={month} />}
            {flow && <input type="hidden" name="flow" value={flow} />}
            <div className="w-full sm:w-64">
              <input
                name="q"
                defaultValue={q ?? ''}
                placeholder="Search merchant…"
                className={inputClass}
              />
            </div>
            <Button type="submit" variant="secondary">
              <SearchIcon className="h-4 w-4" />
              Search
            </Button>
          </form>
        }
      />

      {(account || category || flow) && (
        <div className="flex items-center gap-2 text-sm">
          <span className="rounded-full bg-emerald-050 px-3 py-1 text-emerald-600">
            {account
              ? `Account: ${accountName ?? 'one account'}`
              : category
                ? `Category: ${category}${month ? ` · ${month}` : ''}`
                : flow === 'in'
                  ? `Money in${month ? ` · ${month}` : ''}`
                  : `Money out${month ? ` · ${month}` : ''}`}
          </span>
          <a href="/transactions" className="text-muted hover:text-ink">
            Clear
          </a>
        </div>
      )}

      {list.length === 0 ? (
        <Card className="p-8 text-center">
          <p className="text-sm text-muted">
            {account || category || month || flow || safe
              ? 'No transactions to show for this view. (Balances-only accounts like a mortgage have none.)'
              : 'No transactions yet. Connect a bank on the Dashboard.'}
          </p>
        </Card>
      ) : (
        <Card className="overflow-hidden p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left">
                  <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-faint">
                    Date
                  </th>
                  <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-faint">
                    Merchant
                  </th>
                  <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-faint">
                    Category
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wide text-faint">
                    Amount
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.map((t) => (
                  <TransactionRow
                    key={t.id}
                    t={t}
                    categoryName={effectiveCategory(t, pfcMap)}
                    categoryOptions={categoryOptions}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  )
}
