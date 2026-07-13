'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

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
    <button
      onClick={refresh}
      disabled={busy}
      className="rounded border px-3 py-1.5 text-sm hover:bg-gray-50 disabled:opacity-50"
    >
      {busy ? 'Refreshing…' : 'Refresh'}
    </button>
  )
}
