'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { buttonClass } from '@/components/ui/Button'
import { RefreshIcon } from '@/components/ui/icons'

type SyncResult = {
  banks?: number
  added?: number
  brokenNow?: number
  failed?: number
  skipped?: number
  problems?: { bank: string; status: string; code: string }[]
}

export function RefreshButton() {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [isProblem, setIsProblem] = useState(false)

  async function refresh() {
    setBusy(true)
    setMessage(null)
    try {
      const res = await fetch('/api/plaid/sync-transactions', { method: 'POST' })
      const body = (await res.json().catch(() => ({}))) as SyncResult & { error?: string }
      setBusy(false)

      // A refresh that quietly swallowed its own result is how the numbers go stale without
      // anyone noticing — the exact failure this whole project exists to prevent.
      if (!res.ok) {
        setIsProblem(true)
        setMessage(body.error ?? "Couldn't refresh. Please try again.")
        return
      }

      const bad = (body.brokenNow ?? 0) + (body.failed ?? 0) + (body.skipped ?? 0)
      const ok = (body.banks ?? 0) - bad
      if (bad > 0) {
        setIsProblem(true)
        setMessage(
          `Updated ${ok} of ${body.banks} banks — ${bad} need${bad === 1 ? 's' : ''} attention. See Settings.`
        )
      } else {
        setIsProblem(false)
        setMessage(
          body.added ? `Updated ${body.banks} banks · ${body.added} new` : 'Everything up to date'
        )
      }
      router.refresh()
    } catch {
      setBusy(false)
      setIsProblem(true)
      setMessage("Couldn't reach the app. Check your connection.")
    }
  }

  return (
    <div className="flex items-center gap-2">
      {message && (
        <span className={`text-xs ${isProblem ? 'text-coral' : 'text-muted'}`}>{message}</span>
      )}
      <button onClick={refresh} disabled={busy} className={buttonClass('secondary', 'md')}>
        <RefreshIcon className={`h-4 w-4 ${busy ? 'animate-spin' : ''}`} />
        {busy ? 'Refreshing…' : 'Refresh'}
      </button>
    </div>
  )
}
