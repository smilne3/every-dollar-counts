import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { AppShell } from '@/components/AppShell'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // The one read in the app deliberately left unchecked. app/(app)/error.tsx is a route-segment
  // boundary for the PAGES under this layout, and its own comment notes the layout "sits above this
  // boundary and is unaffected" — so throwing here would take down the whole shell rather than show
  // the retryable message. It also only needs a display name, and has a fallback for it.
  const { data: households } = await supabase.from('households').select('id, name').limit(1)
  const householdName = households?.[0]?.name ?? 'Your household'

  return (
    <AppShell householdName={householdName} userEmail={user.email ?? ''}>
      {children}
    </AppShell>
  )
}
