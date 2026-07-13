import { createClient } from '@/lib/supabase/server'
import { InvitePartnerForm } from '@/components/InvitePartnerForm'
import { LinkButton } from '@/components/LinkButton'
import { CategoryManager } from '@/components/CategoryManager'

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
    <div className="space-y-8">
      <h1 className="text-2xl font-semibold">Settings</h1>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Household</h2>
        {household ? (
          <>
            <p className="text-sm text-gray-600">
              You&apos;re in <strong>{household.name}</strong>.
            </p>
            <InvitePartnerForm householdId={household.id} />
          </>
        ) : (
          <p className="text-sm text-gray-600">No household found for your account.</p>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Banks</h2>
        <p className="text-sm text-gray-600">
          {count ? `${count} account(s) connected.` : 'No banks connected yet.'}
        </p>
        <LinkButton />
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Categories</h2>
        <p className="text-sm text-gray-600">
          Rename or delete any category, or add your own. Renames update everywhere; deleting a
          category leaves its transactions uncategorized.
        </p>
        <CategoryManager initialCategories={categories ?? []} />
      </section>
    </div>
  )
}
