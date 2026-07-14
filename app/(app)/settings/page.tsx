import { createClient } from '@/lib/supabase/server'
import { InvitePartnerForm } from '@/components/InvitePartnerForm'
import { LinkButton } from '@/components/LinkButton'
import { CategoryManager, type CategoryUsage } from '@/components/CategoryManager'
import { Card } from '@/components/ui/Card'
import { PageHeader } from '@/components/ui/PageHeader'
import { effectiveCategory } from '@/lib/effective-category'
import { pfcToName, type Category } from '@/lib/categories'

export default async function SettingsPage() {
  const supabase = await createClient()
  const { data: households } = await supabase.from('households').select('id, name').limit(1)
  const household = households?.[0]
  const { count } = await supabase.from('accounts').select('id', { count: 'exact', head: true })
  const { data: categories } = await supabase
    .from('categories')
    .select('id, name, pfc_primary, sort_order')
    .order('sort_order')

  // What deleting each category would actually cost you, so the confirmation can say so.
  // Counts by EFFECTIVE category: auto-mapped transactions fall back to Uncategorized once
  // the category row is gone, exactly like user-overridden ones.
  const pfcMap = pfcToName((categories ?? []) as Category[])
  const [{ data: catTxns }, { data: budgetRows }] = await Promise.all([
    supabase.from('transactions').select('user_category, pfc_primary').eq('removed', false),
    supabase.from('budgets').select('category'),
  ])
  const budgeted = new Set((budgetRows ?? []).map((b) => b.category as string))
  const usage: CategoryUsage = {}
  for (const c of categories ?? []) {
    usage[c.name] = { txns: 0, hasBudget: budgeted.has(c.name) }
  }
  for (const t of catTxns ?? []) {
    const name = effectiveCategory(t, pfcMap)
    if (usage[name]) usage[name].txns++
  }

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
        <LinkButton />
      </Card>

      <Card className="p-5 space-y-3">
        <h2 className="text-base font-semibold text-ink">Categories</h2>
        <p className="text-sm text-muted">
          Rename or delete any category, or add your own. Renames update everywhere; deleting a
          category leaves its transactions uncategorized.
        </p>
        <CategoryManager initialCategories={categories ?? []} usage={usage} />
      </Card>
    </div>
  )
}
