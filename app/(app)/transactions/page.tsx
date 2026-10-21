import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { MissingBalancesNote } from '@/components/MissingBalancesNote'
import { NotSyncingBanner } from '@/components/NotSyncingBanner'
import { TransactionRow } from '@/components/TransactionRow'
import { TransactionCard } from '@/components/TransactionCard'
import { Card } from '@/components/ui/Card'
import { PageHeader } from '@/components/ui/PageHeader'
import { Button } from '@/components/ui/Button'
import { SearchIcon } from '@/components/ui/icons'
import { inputClass } from '@/components/ui/styles'
import { fetchCategoryContext, SUGGESTION_EMBED, withSuggestion } from '@/lib/category-context'
import { resolveCategory } from '@/lib/category-rules'
import { filterByCategory, filterByFlow } from '@/lib/category-views'
import { buildSpendContext } from '@/lib/spend-context'
import { currentHouseholdId } from '@/lib/household'
import { listItemsForHousehold } from '@/lib/plaid-items'

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
  // The household beside the categories, and its banks beside the account names below: the bank
  // list the "isn't syncing" banner needs (#135, #171) is two reads, and this way it adds no wait of
  // its own (#156).
  // Throws on a failed read: with no categories every row would be relabelled 'Uncategorized' and
  // the category filter would match nothing (#46).
  const [data, householdId] = await Promise.all([fetchCategoryContext(), currentHouseholdId()])
  const categoryOptions = data.categories.map((c) => c.name)

  // account_id -> name, for the phone sheet's Account row (TransactionCard's accountName prop —
  // see spec: "when I tap a transaction, I expect to see the more tiles"). Twelve accounts is
  // nothing to fetch on every load. Not the same query as the single-account read below, which
  // names ONE account for the filter chip when drilling in from a Net Worth / Cash row — this one
  // reads every account so each row can look its own up, and with its bank, so the note can say
  // which banks have none yet (#170).
  // A failed bank read throws too: rendered as no banks, a broken bank's transactions would stop
  // at its last sync with nothing to say why (#46). An account with no household has no banks,
  // and none is read.
  const [{ data: accountRows, error: accountRowsError }, items] = await Promise.all([
    supabase.from('accounts').select('account_id, name, plaid_item_id'),
    householdId ? listItemsForHousehold(householdId) : [],
  ])
  if (accountRowsError) throw new Error(`could not read account names: ${accountRowsError.message}`)
  const accountNameById = new Map<string, string>()
  for (const a of accountRows ?? []) {
    if (a.name) accountNameById.set(a.account_id, a.name)
  }

  // The transactions query's SQL date filter.
  let monthStart: string | null = null
  let monthEnd: string | null = null
  if (month) {
    const [y, m] = month.split('-').map(Number)
    monthStart = `${month}-01`
    const nextY = m === 12 ? y + 1 : y
    const nextM = m === 12 ? 1 : m + 1
    monthEnd = `${nextY}-${String(nextM).padStart(2, '0')}-01`
  }

  // Only needed to name the account in the filter chip when drilling in from a Net Worth / Cash row.
  let accountName: string | null = null
  if (account) {
    const { data: acct, error: acctError } = await supabase
      .from('accounts')
      .select('name')
      .eq('account_id', account)
      .maybeSingle()
    if (acctError) throw new Error(`could not read the account name: ${acctError.message}`)
    accountName = acct?.name ?? null
  }

  const PER_PAGE = 200
  const page = inMemoryFiltered ? 1 : Math.max(1, Number(pageParam) || 1)
  const from = (page - 1) * PER_PAGE

  // { count: 'exact' } returns the TOTAL matching count alongside the ranged page, so the list can
  // say "Showing 200 of 1,847" instead of silently ending at 200 (#7).
  let query = supabase
    .from('transactions')
    .select(
      `id, name, merchant_name, amount, date, user_category, pfc_primary, pfc_detailed, account_id, reimbursable_amount, reimbursable_note, ${SUGGESTION_EMBED}`,
      { count: 'exact' }
    )
    .eq('removed', false)
    .order('date', { ascending: false })
    .order('id', { ascending: false })  // #50: `date` is day-granular and ties constantly; without a unique second key Postgres may return tied rows in any order, so an UPDATE reshuffles the list under the reader.
    .range(from, from + PER_PAGE - 1)
  if (safe) query = query.or(`name.ilike.%${safe}%,merchant_name.ilike.%${safe}%`)
  // Account and month are plain columns — filter in SQL.
  if (account) query = query.eq('account_id', account)
  if (month) query = query.gte('date', monthStart!).lt('date', monthEnd!)
  const { data: txns, count, error: txnsError } = await query
  // "No transactions" and "we could not read your transactions" must not look the same (#46).
  if (txnsError) throw new Error(`could not read transactions: ${txnsError.message}`)
  const totalMatching = count ?? 0

  // The fifth money surface (design spec §6/§7): the same SpendContext the other four build, built
  // from this page's own fetched rows — reimbursable now lives on the transaction, so there is no
  // second query to keep in sync with this page's own filters/pagination.
  const rows = withSuggestion(txns ?? [])
  const ctx = buildSpendContext({ data, txns: rows })

  // Category and flow are on the transaction's EFFECTIVE category (computed), so filter in memory.
  let list = rows
  if (category) list = filterByCategory(list, category, ctx)
  if (flow === 'in' || flow === 'out') list = filterByFlow(list, flow, ctx)

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
      <NotSyncingBanner items={items} />
      {/* A bank with no accounts yet has no transactions here either: each needs its account (#170). */}
      <MissingBalancesNote items={items} accounts={accountRows ?? []} />
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
          {/* Unfiltered and empty is either a household with no bank, or one whose bank hasn't
              sent any yet, which can take hours after it is linked (#185). Only the first is told
              to connect one: telling the second invites linking the same bank again, which spends
              one of ten lifetime connections (#51). It links to the page with the button, rather
              than naming a page the nav calls Overview, and Home on a phone (#192). */}
          <p className="text-sm text-muted">
            {account || category || month || flow || safe || page > 1
              ? 'No transactions to show for this view. (Balances-only accounts like a mortgage have none.)'
              : items.length === 0
                ? (
                    <>
                      No transactions yet.{' '}
                      <Link href="/dashboard" className="text-emerald hover:text-emerald-600">
                        Connect a bank
                      </Link>
                      .
                    </>
                  )
                : items.length === 1
                  ? "Your bank is connected, but its transactions haven't arrived yet. They can take a few hours on a new connection."
                  : "Your banks are connected, but their transactions haven't arrived yet. They can take a few hours on a new connection."}
          </p>
        </Card>
      ) : (
        <Card className="overflow-hidden p-0">
          {/* Phone: the six-column table needs ~800px and gets 390, where `w-full table-fixed`
              stops overflow-x-auto engaging and the amount is painted over the category pill.
              Below md the same rows render as cards instead. */}
          <div className="md:hidden">
            {list.map((t) => (
              <TransactionCard
                key={t.id}
                t={t}
                category={resolveCategory(t, ctx)}
                categoryOptions={categoryOptions}
                accountName={accountNameById.get(t.account_id)}
              />
            ))}
          </div>
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full table-fixed text-sm">
              <colgroup>
                <col className="w-32" />
                <col className="w-52" />
                <col />
                <col className="w-40" />
                <col className="w-36" />
                <col className="w-20" />
              </colgroup>
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
                    Reimbursable
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wide text-faint">
                    <span className="sr-only">More</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.map((t) => (
                  <TransactionRow
                    key={t.id}
                    t={t}
                    category={resolveCategory(t, ctx)}
                    categoryOptions={categoryOptions}
                  />
                ))}
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
