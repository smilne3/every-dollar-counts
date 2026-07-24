'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { usePlaidLink } from 'react-plaid-link'
import { buttonClass } from '@/components/ui/Button'
import {
  savePendingLink,
  clearPendingLink,
  completePendingLink,
} from '@/components/plaid-link-context'

// Reopens Link in update mode to fix a broken login. The access token is unchanged, so on success
// completePendingLink just clears the broken flag and resyncs. Critically, update mode does NOT
// create a new Item — this is the free alternative to disconnect-and-relink, which would spend one
// of ten unrefundable slots.
export function ReconnectButton({ itemId }: { itemId: string }) {
  const router = useRouter()
  const [token, setToken] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const onSuccess = useCallback(async () => {
    setBusy(true)
    const result = await completePendingLink('', { institution: null })
    setBusy(false)
    setToken(null)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setError(null)
    router.refresh()
  }, [router])

  const onExit = useCallback((err: { display_message?: string | null } | null) => {
    clearPendingLink()
    setBusy(false)
    setToken(null)
    if (err) setError(err.display_message ?? "That didn't finish — the bank is still disconnected.")
  }, [])

  const { open, ready } = usePlaidLink({ token, onSuccess, onExit })

  useEffect(() => {
    if (token && ready) open()
  }, [token, ready, open])

  const start = useCallback(async () => {
    setError(null)
    let body: { link_token?: string; error?: string } = {}
    try {
      const res = await fetch('/api/plaid/create-link-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'update', itemId }),
      })
      body = await res.json().catch(() => ({}))
      if (!res.ok || !body.link_token) {
        setError(body.error ?? "Couldn't start the reconnection. Please try again.")
        return
      }
    } catch {
      setError("Couldn't reach the app. Check your connection, then try again.")
      return
    }
    savePendingLink({ token: body.link_token, mode: 'update', itemId })
    setToken(body.link_token)
  }, [itemId])

  return (
    <div className="flex flex-col items-end gap-1">
      <button onClick={start} disabled={busy} className={buttonClass('secondary', 'sm')}>
        {busy ? 'Reconnecting…' : 'Reconnect'}
      </button>
      {error && <span className="text-xs text-coral">{error}</span>}
    </div>
  )
}
