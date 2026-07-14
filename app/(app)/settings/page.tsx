import { createClient } from '@/lib/supabase/server'
import { InvitePartnerForm } from '@/components/InvitePartnerForm'
import { LinkButton } from '@/components/LinkButton'
import { CategoryManager } from '@/components/CategoryManager'
import { Card } from '@/components/ui/Card'
import { PageHeader } from '@/components/ui/PageHeader'

export default async function SettingsPage() {
  const supabase = await createClient()
  const { data: households } = await supabase.from('households').select('id, name').limit(1)
  const household = households?.[0]
  const { count } = await supabase.from('accounts').select('id', { count: 'exact', head: true })
  const { data: categories } = await supabase
    .from('categories')
    .select('id, name, pfc_primary, sort_order')
    .order('sort_order')

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
        <CategoryManager initialCategories={categories ?? []} />
      </Card>
    </div>
  )
}
