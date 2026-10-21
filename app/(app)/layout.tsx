import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { checkSignIn } from '@/lib/auth-check'
import { AppShell } from '@/components/AppShell'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient()
  const signIn = await checkSignIn(supabase, '[layout]')
  // Supabase Auth could not be asked, so the session may be fine (#143): sent to /login, the person
  // would be signed out by an outage. The proxy answers a page itself when its own check can't be
  // made, so this is a check that passed there and failed here. Thrown, to app/error.tsx, the
  // boundary above this layout (app/(app)/error.tsx is below it), which says sign-in couldn't be
  // checked and offers a retry. Next logs this message with the digest that boundary shows (#130).
  if (signIn.state === 'unknown') throw new Error(`could not check sign-in: ${signIn.error.message}`)
  if (signIn.state === 'ended') redirect('/login')
  const { user } = signIn

  // The one read in the app deliberately left unchecked. app/(app)/error.tsx is a route-segment
  // boundary for the PAGES under this layout, and its own comment notes the layout "sits above this
  // boundary and is unaffected" — so throwing here would take down the whole shell rather than show
  // the retryable message, and app/error.tsx would say sign-in couldn't be checked. It also only
  // needs a display name, and has a fallback for it.
  const { data: households } = await supabase.from('households').select('id, name').limit(1)
  const householdName = households?.[0]?.name ?? 'Your household'

  return (
    <AppShell householdName={householdName} userEmail={user.email ?? ''}>
      {children}
    </AppShell>
  )
}
