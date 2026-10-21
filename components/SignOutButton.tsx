'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { clearSessionCookie, createClient } from '@/lib/supabase/client'
import { LogOutIcon } from '@/components/ui/icons'

// Presentation is supplied by the caller via `className` so this works both
// in the dark sidebar footer and the light mobile top bar.
export function SignOutButton({
  className = '',
  showLabel = true,
}: {
  className?: string
  showLabel?: boolean
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  async function signOut() {
    setBusy(true)
    const supabase = createClient()
    const { error } = await supabase.auth.signOut()
    // supabase-js removes the session from this browser even when Supabase Auth can't be told,
    // except when the session first needs a refresh Supabase Auth can't give, an expired token in an
    // outage: then it removes nothing, at any scope, and the session outlived Sign out (#143). So its
    // cookie is cleared here instead, and Sign out always signs this device out. Supabase Auth keeps
    // the session until it lapses, but nothing here holds it any more.
    if (error) {
      console.error('[SignOutButton] sign-out failed', { status: error.status, message: error.message })
      await clearSessionCookie()
    }
    router.push('/login')
    router.refresh()
  }

  return (
    <button onClick={signOut} disabled={busy} className={className} title="Sign out">
      <LogOutIcon className="h-[18px] w-[18px] shrink-0" />
      {showLabel && <span>{busy ? 'Signing out…' : 'Sign out'}</span>}
    </button>
  )
}
