'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { buttonClass } from '@/components/ui/Button'
import { RefreshIcon } from '@/components/ui/icons'

export function RefreshButton() {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  async function refresh() {
    setBusy(true)
    await fetch('/api/plaid/sync-transactions', { method: 'POST' })
    setBusy(false)
    router.refresh()
  }

  return (
    <button onClick={refresh} disabled={busy} className={buttonClass('secondary', 'md')}>
      <RefreshIcon className={`h-4 w-4 ${busy ? 'animate-spin' : ''}`} />
      {busy ? 'Refreshing…' : 'Refresh'}
    </button>
  )
}
