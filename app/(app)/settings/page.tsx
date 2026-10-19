import { createClient } from '@/lib/supabase/server'
import { InvitePartnerForm } from '@/components/InvitePartnerForm'
import { LinkButton } from '@/components/LinkButton'
import { BankList } from '@/components/BankList'
import { listItemsForHousehold } from '@/lib/plaid-items'
import { countSlotsUsed, LIFETIME_SLOTS } from '@/lib/plaid-slots'
import { HomeValueCard } from '@/components/HomeValueCard'
import { TimezoneCard } from '@/components/TimezoneCard'
import { DEFAULT_TIMEZONE } from '@/lib/household'
import { listManualAssets } from '@/lib/manual-assets'
import { CategoryManager, type CategoryUsage } from '@/components/CategoryManager'
import { Card } from '@/components/ui/Card'
import { PageHeader } from '@/components/ui/PageHeader'
import { fetchCategoryContext, readTransactionsForCounts } from '@/lib/category-context'
import { buildCategoryContext, kindOf } from '@/lib/category-rules'
import { categoryUsage, deleteImpact } from '@/lib/category-views'
import { CategoryRulesCard, type RuleView, type RuleCategory } from '@/components/CategoryRulesCard'
import type { Category } from '@/lib/categories'

type CategorySettings = {
  categories: Category[]
  usage: CategoryUsage
  rules: RuleView[]
  ruleCategories: RuleCategory[]
  suggestedCount: number | null // null while suggestions are off (spec §14.7): no Jev line
}

type Supabase = Awaited<ReturnType<typeof createClient>>

async function readBudgetNames(supabase: Supabase): Promise<Set<string>> {
  const { data: budgetRows, error: budgetsError } = await supabase.from('budgets').select('category')
  // Checked (#91): unchecked, a failed read showed every budget as absent in the delete dialog.
  if (budgetsError) {
    const code = budgetsError.code ? `${budgetsError.code} ` : ''
    throw new Error(`could not read budgets: ${code}${budgetsError.message}`)
  }
  // No data and no error is not "no budgets" (#46).
  if (!budgetRows) throw new Error('could not read budgets: read returned no data and no error')
  return new Set(budgetRows.map((b) => b.category as string))
}

// How many accounts are connected, for the Banks card's first line. Checked (#91): unchecked, a
// failed read printed "No banks connected yet." beside Connect a bank.
async function countAccounts(supabase: Supabase): Promise<number> {
  const { count, error } = await supabase.from('accounts').select('id', { count: 'exact', head: true })
  if (error) {
    const code = error.code ? `${error.code} ` : ''
    throw new Error(`could not count accounts: ${code}${error.message}`)
  }
  // No count and no error is not "no accounts" (#46).
  if (count == null) throw new Error('could not count accounts: read returned no count and no error')
  return count
}

// Everything the Categories and Category rules cards need. Throws if any read fails; the page
// catches it, because Settings is the only place a bank can be reconnected (spec §7.3).
async function loadCategorySettings(supabase: Supabase): Promise<CategorySettings> {
  const [data, rows, budgetNames] = await Promise.all([
    fetchCategoryContext(),
    readTransactionsForCounts(),
    readBudgetNames(supabase),
  ])
  const ctx = buildCategoryContext(data)
  const counts = categoryUsage(rows, data, budgetNames)
  const usage: CategoryUsage = {}
  for (const c of data.categories) {
    usage[c.name] = { ...counts.categories[c.name], impact: deleteImpact(rows, data, c.id) }
  }
  const nameById = new Map(data.categories.map((c) => [c.id, c.name]))
  return {
    categories: data.categories,
    usage,
    rules: data.rules.map((r) => ({
      id: r.id,
      merchantLabel: r.merchant_label,
      categoryId: r.category_id,
      // The FK deletes a rule with its category, so a missing name is a race with a delete.
      categoryName: nameById.get(r.category_id) ?? 'a deleted category',
      origin: r.origin,
      ...counts.rules[r.id],
    })),
    ruleCategories: data.categories.map((c) => ({ id: c.id, name: c.name, kind: kindOf(c.name, ctx) })),
    suggestedCount: data.suggestionsOn ? counts.suggested : null,
  }
}

// The value, or null when the read throws. Settings alone catches its reads, one card at a time:
// it is the only place a bank can be reconnected (spec §7.3), so one failed read must not take the
// page down. The card whose read failed says so, and shows no value in place of the one it could
// not read, so this still honours #46 (#91). Logged, so the server log names the read.
async function readOrNull<T>(what: string, read: () => Promise<T>): Promise<T | null> {
  try {
    return await read()
  } catch (e) {
    console.error(`[settings] could not load ${what}`, e)
    return null
  }
}

// What a card shows in place of a read that failed. A plain function, not a component, so the
// markup appears in the unrendered tree the page test reads. `Try again.` is a plain link so it
// works in the installed app, which has no reload button (#139).
function unavailable(message: string) {
  return (
    <p role="alert" className="text-sm text-coral">
      {message}{' '}
      <a href="/settings" className="font-medium underline">
        Try again.
      </a>
    </p>
  )
}

export default async function SettingsPage() {
  const supabase = await createClient()
  const { data: households, error: householdsError } = await supabase
    .from('households')
    .select('id, name, timezone')
    .limit(1)
  if (householdsError) throw new Error(`could not read your household: ${householdsError.message}`)
  // No data and no error is not "no household" either (#46): every card below would render as if
  // nothing were connected.
  if (!households) throw new Error('could not read your household: read returned no data and no error')
  const household = households[0]
  const accountCount = await readOrNull('the account count', () => countAccounts(supabase))
  const items = household ? await readOrNull('the banks', () => listItemsForHousehold(household.id)) : []
  // Null when it cannot be established — BankList falls back to the old wording rather than
  // printing a number nobody stands behind.
  const slotsUsed = household ? await countSlotsUsed(household.id) : null
  const manualAssets = household ? await readOrNull('the home value', () => listManualAssets(household.id)) : []
  const home = manualAssets?.find((a) => a.name === 'Home') ?? null
  // Four reads (see loadCategorySettings); if any fails, the Categories and Category rules cards
  // both say so.
  const categorySettings = await readOrNull('categories and rules', () => loadCategorySettings(supabase))
  const categoriesUnavailable = unavailable("Couldn't load categories and rules.")

  return (
    <div className="space-y-6">
      <PageHeader title="Settings" subtitle="Manage your household, banks, and categories" />

      <Card className="p-5 space-y-3">
        <h2 className="text-base font-semibold text-ink">Household</h2>
        {household ? (
          <>
            <p className="text-sm text-muted">
              You&apos;re in <strong className="font-medium text-ink">{household.name}</strong>.
            </p>
            <InvitePartnerForm householdId={household.id} />
            <TimezoneCard current={(household.timezone as string) ?? DEFAULT_TIMEZONE} />
          </>
        ) : (
          <p className="text-sm text-muted">No household found for your account.</p>
        )}
      </Card>

      <Card className="p-5 space-y-3">
        <h2 className="text-base font-semibold text-ink">Banks</h2>
        {accountCount === null ? (
          unavailable("Couldn't check your accounts.")
        ) : (
          <p className="text-sm text-muted">
            {accountCount ? `${accountCount} account(s) connected.` : 'No banks connected yet.'}
          </p>
        )}
        {/* With the list unreadable, Connect a bank would invite a relink of a bank that is still
            connected, which spends one of ten lifetime connections (#51), and its own warning
            points at "the list above". So it waits for the list. */}
        {items ? (
          <>
            <BankList items={items} slotsUsed={slotsUsed} lifetimeSlots={LIFETIME_SLOTS} />
            <LinkButton />
          </>
        ) : (
          unavailable("Couldn't load your banks.")
        )}
      </Card>

      <Card className="p-5 space-y-3">
        <h2 className="text-base font-semibold text-ink">Home value</h2>
        <p className="text-sm text-muted">
          Add your home&apos;s value so net worth reflects your equity. The mortgage is already
          counted as a debt, so this shows what the house adds after the loan.
        </p>
        {manualAssets ? (
          <HomeValueCard initialValue={home?.value ?? null} updatedAt={home?.updated_at ?? null} />
        ) : (
          unavailable("Couldn't load your home value.")
        )}
      </Card>

      <Card className="p-5 space-y-3">
        <h2 className="text-base font-semibold text-ink">Categories</h2>
        <p className="text-sm text-muted">
          Rename or delete any category, or add your own. Renames update everywhere. Before you delete
          one, it shows where that category&apos;s transactions will go.
        </p>
        {categorySettings ? (
          <CategoryManager initialCategories={categorySettings.categories} usage={categorySettings.usage} />
        ) : (
          categoriesUnavailable
        )}
      </Card>

      {/* scroll-mt clears the phone's sticky h-14 top bar (AppShell), so a #category-rules link
          does not land the heading under it; there is no sticky bar from md up. */}
      <Card id="category-rules" className="scroll-mt-20 md:scroll-mt-6 p-5 space-y-3">
        <h2 className="text-base font-semibold text-ink">Category rules</h2>
        {categorySettings ? (
          <CategoryRulesCard
            rules={categorySettings.rules}
            categories={categorySettings.ruleCategories}
            suggestedCount={categorySettings.suggestedCount}
          />
        ) : (
          categoriesUnavailable
        )}
      </Card>
    </div>
  )
}
