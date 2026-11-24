import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { spendByCategory } from '@/lib/budget'
import { spendingCategoryNames } from '@/lib/categories'
import { fetchCategoryContext, SUGGESTION_EMBED, withSuggestion } from '@/lib/category-context'
import { buildSpendContext } from '@/lib/spend-context'
import { BudgetEditor } from '@/components/BudgetEditor'
import { NotSyncingBanner } from '@/components/NotSyncingBanner'
import { PageHeader } from '@/components/ui/PageHeader'
import { buttonClass } from '@/components/ui/Button'
import { tapTargetClass } from '@/components/ui/styles'
import { todayIn } from '@/lib/clock'
import { currentHouseholdId, householdTimezone } from '@/lib/household'
import { listItemsForHousehold } from '@/lib/plaid-items'
import { readAllRows } from '@/lib/read-all'

type Supabase = Awaited<ReturnType<typeof createClient>>

// The household's limits, and when they were read by the server's clock, for BudgetEditor to tell
// this read from one made before its last save was written. The time is taken before the read, so
// it is never later than it (#176).
async function readBudgets(supabase: Supabase) {
  const readAt = Date.now()
  const { data: budgets, error: budgetsError } = await supabase
    .from('budgets')
    .select('category, monthly_limit')
  if (budgetsError) throw new Error(`could not read budgets: ${budgetsError.message}`)
  // An empty response body comes back as no data and no error. That's a failed read too, not "none" (#222).
  if (!budgets) throw new Error('could not read budgets: read returned no data and no error')
  return { budgets, readAt }
}

// The household's month, not the server's: at 8pm US Eastern the server is already tomorrow, so on
// the last evening of a month every bar on this page emptied four hours early (#73). Paged, so the
// month cannot silently pass the 1,000-row cap (#69).
async function readMonth(supabase: Supabase, tz: string) {
  const today = todayIn(tz)
  const year = Number(today.slice(0, 4))
  const month = Number(today.slice(5, 7))
  const monthStart = `${today.slice(0, 7)}-01`
  // Constructed in UTC and read back in UTC, so the two cancel and December rolls to January
  // without any local zone involved.
  const next = new Date(Date.UTC(year, month, 1))
  const nextMonthStart = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-01`
  const { data: txns, error: txnsError } = await readAllRows(() =>
    supabase
      .from('transactions')
      .select(`id, amount, date, merchant_name, user_category, pfc_primary, pfc_detailed, reimbursable_amount, ${SUGGESTION_EMBED}`)
      .eq('removed', false)
      .gte('date', monthStart)
      .lt('date', nextMonthStart)
  )
  // Every bar would read empty — indistinguishable from a month where nothing was spent (#46).
  if (txnsError) throw new Error(`could not read transactions: ${txnsError.message}`)
  return txns
}

export default async function BudgetsPage() {
  const supabase = await createClient()

  // Every read starts as soon as what it needs is known, and none waits for one it doesn't need
  // (#226, as #225 did for the Dashboard). The categories and the limits need nothing; the month's
  // transactions need only the timezone; the banks the "isn't syncing" banner reads (#135) need only
  // the household. One Promise.all over all of them, so the first failure fails the page at once,
  // and none is left unhandled while another is awaited.
  //
  // Each throws on a failed read: with no categories the page would render as though the household
  // had never set any up, with no banks every bank would look healthy, and with no transactions
  // every bar would read empty (#46). An account with no household has no banks, and none is read.
  const month = householdTimezone().then((tz) => readMonth(supabase, tz))
  const banks = currentHouseholdId().then((householdId) => (householdId ? listItemsForHousehold(householdId) : []))
  const [data, items, { budgets, readAt }, txns] = await Promise.all([
    fetchCategoryContext(),
    banks,
    readBudgets(supabase),
    month,
  ])
  const categoryNames = spendingCategoryNames(data.categories)

  // The reimbursable map is built straight from this page's own transaction rows — see
  // buildSpendContext.
  const rows = withSuggestion(txns ?? [])
  const ctx = buildSpendContext({ data, txns: rows })
  const spend = spendByCategory(rows, ctx)
  const initialLimits: Record<string, number> = {}
  for (const b of budgets) initialLimits[b.category] = Number(b.monthly_limit)

  return (
    <div className="space-y-6">
      <NotSyncingBanner items={items} />
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
        <Link href="/settings" className={`${tapTargetClass} text-emerald hover:text-emerald-600`}>
          Settings → Categories
        </Link>
        .
      </p>
      <BudgetEditor categoryNames={categoryNames} initialLimits={initialLimits} readAt={readAt} spend={spend} />
    </div>
  )
}
