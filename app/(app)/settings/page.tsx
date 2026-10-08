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
import { buildCategoryContext, kindOf, type Kind } from '@/lib/category-rules'
import { categoryUsage, deleteImpact, type RuleCounts } from '@/lib/category-views'
import type { Category } from '@/lib/categories'

// What the Category rules card shows per rule (Task 9 renders it).
export type RuleView = RuleCounts & {
  id: string
  merchantLabel: string
  categoryId: string
  categoryName: string
  origin: 'seeded' | 'learned'
}
export type RuleCategory = { id: string; name: string; kind: Kind }

type CategorySettings = {
  categories: Category[]
  usage: CategoryUsage
  rules: RuleView[]
  ruleCategories: RuleCategory[]
}

type Supabase = Awaited<ReturnType<typeof createClient>>

async function readBudgetNames(supabase: Supabase): Promise<Set<string>> {
  const { data: budgetRows, error: budgetsError } = await supabase.from('budgets').select('category')
  // Checked (#91): unchecked, a failed read showed every budget as absent in the delete dialog.
  if (budgetsError) throw new Error(`could not read budgets: ${budgetsError.message}`)
  return new Set((budgetRows ?? []).map((b) => b.category as string))
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
  }
}

export default async function SettingsPage() {
  const supabase = await createClient()
  const { data: households, error: householdsError } = await supabase
    .from('households')
    .select('id, name, timezone')
    .limit(1)
  if (householdsError) throw new Error(`could not read your household: ${householdsError.message}`)
  const household = households?.[0]
  const { count } = await supabase.from('accounts').select('id', { count: 'exact', head: true })
  const items = household ? await listItemsForHousehold(household.id) : []
  // Null when it cannot be established — BankList falls back to the old wording rather than
  // printing a number nobody stands behind.
  const slotsUsed = household ? await countSlotsUsed(household.id) : null
  const manualAssets = household ? await listManualAssets(household.id) : []
  const home = manualAssets.find((a) => a.name === 'Home') ?? null
  // On Settings alone a failed categories, rules, transactions or budgets read is caught: the
  // Categories and Category rules cards say so, and Household, Banks and Home value still render.
  // No number is shown in their place, so this still honours #46.
  let categorySettings: CategorySettings | null = null
  try {
    categorySettings = await loadCategorySettings(supabase)
  } catch (e) {
    console.error('[settings] could not load categories and rules', e)
  }
  // Inline markup, not a component, so it appears in the unrendered tree the page test reads.
  // `Try again.` is a plain link so it works in the installed app, which has no reload button (#139).
  const categoriesUnavailable = (
    <p role="alert" className="text-sm text-coral">
      Couldn&apos;t load categories and rules.{' '}
      <a href="/settings" className="font-medium underline">
        Try again.
      </a>
    </p>
  )

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
        <p className="text-sm text-muted">
          {count ? `${count} account(s) connected.` : 'No banks connected yet.'}
        </p>
        <BankList items={items} slotsUsed={slotsUsed} lifetimeSlots={LIFETIME_SLOTS} />
        <LinkButton />
      </Card>

      <Card className="p-5 space-y-3">
        <h2 className="text-base font-semibold text-ink">Home value</h2>
        <p className="text-sm text-muted">
          Add your home&apos;s value so net worth reflects your equity. The mortgage is already
          counted as a debt, so this shows what the house adds after the loan.
        </p>
        <HomeValueCard initialValue={home?.value ?? null} updatedAt={home?.updated_at ?? null} />
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
    </div>
  )
}
