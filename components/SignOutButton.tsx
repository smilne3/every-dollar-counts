'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
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
    await supabase.auth.signOut()
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
