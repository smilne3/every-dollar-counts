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
import { useIsStandalone } from '@/lib/useIsStandalone'
import { SAVE_TIMEOUT_MS, sendRequest } from '@/lib/save-response'

// Reopens Link in update mode to fix a broken login. The access token is unchanged, so on success
// completePendingLink just clears the broken flag and resyncs. Critically, update mode does NOT
// create a new Item — this is the free alternative to disconnect-and-relink, which would spend one
// of ten unrefundable slots.
export function ReconnectButton({ itemId }: { itemId: string }) {
  const router = useRouter()
  // Not from the installed app, for the reason LinkButton gives: the bank's return could land in
  // the browser, away from the pending link this app's storage holds.
  const standalone = useIsStandalone()
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
    // As LinkButton's start: a link token is free, so a save's timeout, and a lost reply changed
    // nothing, since Link never opened (#165).
    const result = await sendRequest(
      '/api/plaid/create-link-token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'update', itemId }),
      },
      SAVE_TIMEOUT_MS
    )
    const linkToken = result.outcome === 'answered' ? result.body.link_token : undefined
    if (typeof linkToken !== 'string' || linkToken === '') {
      if (result.outcome === 'unknown') console.error('[ReconnectButton] link token request failed', result.cause)
      setError(result.outcome === 'refused' ? result.error : "Couldn't start the reconnection. Please try again.")
      return
    }
    savePendingLink({ token: linkToken, mode: 'update', itemId })
    setToken(linkToken)
  }, [itemId])

  return (
    <div className="flex flex-col items-end gap-1">
      <button onClick={start} disabled={busy || standalone} className={buttonClass('secondary', 'sm')}>
        {busy ? 'Reconnecting…' : 'Reconnect'}
      </button>
      {standalone && <span className="text-xs text-muted">Reconnect from your browser.</span>}
      {error && <span className="text-xs text-coral">{error}</span>}
    </div>
  )
}
