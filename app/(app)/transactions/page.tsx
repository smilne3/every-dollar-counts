import { createClient } from '@/lib/supabase/server'
import { TransactionRow } from '@/components/TransactionRow'
import { Card } from '@/components/ui/Card'
import { PageHeader } from '@/components/ui/PageHeader'
import { Button } from '@/components/ui/Button'
import { SearchIcon } from '@/components/ui/icons'
import { inputClass } from '@/components/ui/styles'
import { effectiveCategory } from '@/lib/effective-category'
import { money } from '@/lib/format'
import { pfcToName, isCreditCardPayment, type Category } from '@/lib/categories'
import { buildSpendContext } from '@/lib/spend-context'
import { spendableAmount, writeOffsAsTxns, type Split, type WriteOff } from '@/lib/reimbursements'

type RealRow = {
  id: string
  name: string | null
  merchant_name: string | null
  amount: number
  date: string
  user_category: string | null
  pfc_primary: string | null
  pfc_detailed: string | null
}

// A write-off's frozen spending, reshaped for this page's own display. `name`/`merchant_name` are
// cosmetic only — the money math (effectiveCategory, spendableAmount) never looks at them. Never a
// real row: no account_id, so it is deliberately excluded from any account-filtered view — see
// `includeWriteOffs` below.
type WriteOffRow = {
  id: string
  name: string
  merchant_name: string | null
  amount: number
  date: string
  user_category: string
  pfc_primary: null
  pfc_detailed: null
}

type ListRow =
  | ({ isWriteOff: true; claimName: string } & WriteOffRow)
  | ({ isWriteOff: false } & RealRow)

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string
    account?: string
    category?: string
    month?: string
    flow?: string
    page?: string
  }>
}) {
  const { q, account, category, month, flow, page: pageParam } = await searchParams
  const safe = (q ?? '').replace(/[,()%*]/g, ' ').trim()
  // Category/flow are filtered in memory over one page, so those views are single-page (they're
  // month-scoped drill-downs). Ignore any page param on them so a hand-crafted URL can't page into
  // the wrong window.
  const inMemoryFiltered = !!(category || flow === 'in' || flow === 'out')

  const supabase = await createClient()
  const { data: cats } = await supabase
    .from('categories')
    .select('id, name, pfc_primary, sort_order')
    .order('sort_order')
  const categories = (cats ?? []) as Category[]
  const pfcMap = pfcToName(categories)
  const categoryOptions = categories.map((c) => c.name)

  const { data: claimRows } = await supabase
    .from('reimbursement_claims')
    .select('id, name')
    .is('written_off_on', null)
    .order('created_at', { ascending: false })
  const claims = (claimRows ?? []) as { id: string; name: string }[]

  const { data: splitRows } = await supabase
    .from('reimbursement_splits')
    .select('id, transaction_id, claim_id, owed_by, amount')
  const splitsByTxn: Record<string, { id: string; claim_id: string; owed_by: string | null; amount: number }[]> = {}
  for (const s of splitRows ?? []) {
    const key = s.transaction_id as string
    ;(splitsByTxn[key] ??= []).push({
      id: s.id as string,
      claim_id: s.claim_id as string,
      owed_by: s.owed_by as string | null,
      amount: Number(s.amount),
    })
  }
  // Autocomplete for the person field, so "Dave" stays one person instead of fragmenting.
  const knownPeople = [
    ...new Set((splitRows ?? []).map((s) => (s.owed_by as string | null)?.trim()).filter(Boolean)),
  ] as string[]

  // The fifth money surface (design spec §6/§7): the same SpendContext the other four build, reusing
  // the splits already fetched above for the split editor rather than querying twice.
  const ctx = buildSpendContext({ categories, splits: (splitRows ?? []) as Split[] })

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

  // Computed once so the write-offs query below (when it runs) uses the exact same date window as
  // the transactions query's SQL date filter.
  let monthStart: string | null = null
  let monthEnd: string | null = null
  if (month) {
    const [y, m] = month.split('-').map(Number)
    monthStart = `${month}-01`
    const nextY = m === 12 ? y + 1 : y
    const nextM = m === 12 ? 1 : m + 1
    monthEnd = `${nextY}-${String(nextM).padStart(2, '0')}-01`
  }

  const PER_PAGE = 200
  const page = inMemoryFiltered ? 1 : Math.max(1, Number(pageParam) || 1)
  const from = (page - 1) * PER_PAGE

  // { count: 'exact' } returns the TOTAL matching count alongside the ranged page, so the list can
  // say "Showing 200 of 1,847" instead of silently ending at 200 (#7).
  let query = supabase
    .from('transactions')
    .select(
      'id, name, merchant_name, amount, date, user_category, pfc_primary, pfc_detailed, account_id',
      { count: 'exact' }
    )
    .eq('removed', false)
    .order('date', { ascending: false })
    .range(from, from + PER_PAGE - 1)
  if (safe) query = query.or(`name.ilike.%${safe}%,merchant_name.ilike.%${safe}%`)
  // Account and month are plain columns — filter in SQL.
  if (account) query = query.eq('account_id', account)
  if (month) query = query.gte('date', monthStart!).lt('date', monthEnd!)
  const { data: txns, count } = await query
  const totalMatching = count ?? 0

  // Write-offs join the list the same way as the other four money surfaces (budgets/trends/
  // dashboard/breakdown): concatenated in before filtering, so a category or flow drill-down never
  // contradicts the aggregate figure it was linked from (a written-off claim's spending would
  // otherwise exist only as a number on another page, with no row here to show for it).
  //
  // They are synthetic — no account_id, nothing to match a merchant search — so they are excluded
  // from an account-filtered view (they don't belong to any one account) and from a search. They
  // never enter the plain SQL-paginated browse at all: mixing synthetic rows into that path would
  // desync `count` and the shownFrom/shownTo range math against real SQL pagination they aren't
  // part of. The in-memory-filtered views are already single-page, so none of that math applies.
  const includeWriteOffs = inMemoryFiltered && !account && !safe
  let writeOffDisplay: ({ isWriteOff: true; claimName: string } & WriteOffRow)[] = []
  if (includeWriteOffs) {
    let woQuery = supabase.from('reimbursement_write_offs').select('claim_id, category, amount, date')
    if (month) woQuery = woQuery.gte('date', monthStart!).lt('date', monthEnd!)
    const { data: writeOffRows } = await woQuery
    const rows = (writeOffRows ?? []) as WriteOff[]

    const claimIds = [...new Set(rows.map((w) => w.claim_id))]
    const claimNameById: Record<string, string> = {}
    if (claimIds.length) {
      const { data: claimNames } = await supabase
        .from('reimbursement_claims')
        .select('id, name')
        .in('id', claimIds)
      for (const c of claimNames ?? []) claimNameById[c.id as string] = c.name as string
    }

    writeOffDisplay = writeOffsAsTxns(rows).map((w, i) => ({
      ...w,
      name: 'Write-off',
      merchant_name: claimNameById[rows[i].claim_id] ?? null,
      isWriteOff: true as const,
      claimName: claimNameById[rows[i].claim_id] ?? 'Claim',
    }))
  }

  let list: ListRow[] = [
    ...((txns ?? []) as RealRow[]).map((t) => ({ ...t, isWriteOff: false as const })),
    ...writeOffDisplay,
  ]

  // Category and flow are on the transaction's EFFECTIVE category (computed), so filter in memory.
  if (category) {
    list = list.filter((t) => effectiveCategory(t, pfcMap) === category)
  }
  if (flow === 'in' || flow === 'out') {
    list = list.filter((t) => {
      if (isCreditCardPayment(t)) return false
      const cat = effectiveCategory(t, pfcMap)
      if (ctx.transfers.has(cat)) return false
      const isIncomeCat = ctx.nonSpending.has(cat) && !ctx.transfers.has(cat)
      // Netted through spendableAmount, matching monthlyFlows exactly: a fully-tagged reimbursable
      // transaction (either direction) nets to zero and must appear in NEITHER list. This is the
      // flow=in fix: an employer repayment fully tagged to a claim used to still show here even
      // though it contributes $0 to income, so the list didn't reconcile with the figure it drilled
      // from. Without the sign guard below, an income-category *outflow* (a clawback, or a
      // user-overridden row) would show here but never appear in the income total either.
      const amt = spendableAmount(t, ctx.reimbursedByTxn)
      if (amt === 0) return false
      return flow === 'in' ? isIncomeCat && amt < 0 : !isIncomeCat
    })
  }

  // Write-offs were appended after the SQL page's date-descending order, so the merged, filtered
  // list needs re-sorting to stay chronological. Only in-memory-filtered views ever merge them, and
  // those are already single-page, so this never touches the real SQL pagination below.
  if (includeWriteOffs) {
    list = [...list].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
  }

  // `totalMatching` (a SQL count) doesn't describe the in-memory-filtered views, so those show a
  // simple count and no paging (see inMemoryFiltered above).
  const shownFrom = list.length ? from + 1 : 0
  const shownTo = from + list.length
  const hasPrev = !inMemoryFiltered && page > 1
  const hasNext = !inMemoryFiltered && from + PER_PAGE < totalMatching
  const pageHref = (p: number) => {
    const sp = new URLSearchParams()
    if (q) sp.set('q', q)
    if (account) sp.set('account', account)
    if (month) sp.set('month', month)
    if (p > 1) sp.set('page', String(p))
    const qs = sp.toString()
    return qs ? `/transactions?${qs}` : '/transactions'
  }
  const countLabel = inMemoryFiltered
    ? `Showing ${list.length} transaction${list.length === 1 ? '' : 's'}`
    : totalMatching === 0
      ? 'No transactions'
      : `Showing ${shownFrom.toLocaleString()}–${shownTo.toLocaleString()} of ${totalMatching.toLocaleString()}`

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

      {list.length > 0 && <p className="text-xs text-faint">{countLabel}</p>}

      {list.length === 0 ? (
        <Card className="p-8 text-center">
          <p className="text-sm text-muted">
            {account || category || month || flow || safe || page > 1
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
                  <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wide text-faint">
                    <span className="sr-only">Split</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.map((t) =>
                  t.isWriteOff ? (
                    // Frozen history (design spec §5): not editable, so no CategoryPicker or Split
                    // affordance — both would try to mutate a row that doesn't exist in
                    // `transactions`.
                    <tr key={t.id} className="border-b border-line">
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-muted">{t.date}</td>
                      <td className="px-4 py-3 font-medium text-ink">
                        Write-off
                        <span className="block text-xs font-normal text-faint">{t.claimName}</span>
                      </td>
                      <td className="px-4 py-3 text-sm text-muted">{t.user_category}</td>
                      <td className="px-4 py-3 text-right font-medium tabular-nums text-ink">
                        {money(-t.amount)}
                      </td>
                      <td className="px-4 py-3" />
                    </tr>
                  ) : (
                    <TransactionRow
                      key={t.id}
                      t={t}
                      categoryName={effectiveCategory(t, pfcMap)}
                      categoryOptions={categoryOptions}
                      splits={splitsByTxn[t.id] ?? []}
                      claims={claims}
                      knownPeople={knownPeople}
                    />
                  )
                )}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {(hasPrev || hasNext) && (
        <div className="flex items-center justify-between">
          {hasPrev ? (
            <a href={pageHref(page - 1)} className="text-sm font-medium text-emerald hover:text-emerald-600">
              ← Newer
            </a>
          ) : (
            <span />
          )}
          <span className="text-xs text-faint">Page {page}</span>
          {hasNext ? (
            <a href={pageHref(page + 1)} className="text-sm font-medium text-emerald hover:text-emerald-600">
              Older →
            </a>
          ) : (
            <span />
          )}
        </div>
      )}
    </div>
  )
}
