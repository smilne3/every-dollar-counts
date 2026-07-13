import { createClient } from '@/lib/supabase/server'
import { InvitePartnerForm } from '@/components/InvitePartnerForm'

export default async function SettingsPage() {
  const supabase = await createClient()
  const { data: households } = await supabase.from('households').select('id, name').limit(1)
  const household = households?.[0]

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
        <p className="text-sm text-gray-600">Bank connections arrive in the next phase.</p>
      </section>
    </div>
  )
}
