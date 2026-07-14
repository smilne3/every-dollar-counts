import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { AppShell } from '@/components/AppShell'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: households } = await supabase.from('households').select('id, name').limit(1)
  const householdName = households?.[0]?.name ?? 'Your household'

  return (
    <AppShell householdName={householdName} userEmail={user.email ?? ''}>
      {children}
    </AppShell>
  )
}
