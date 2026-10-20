'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { usePlaidLink } from 'react-plaid-link'
import { buttonClass } from '@/components/ui/Button'
import {
  savePendingLink,
  clearPendingLink,
  completePendingLink,
  type CompleteResult,
} from '@/components/plaid-link-context'
import { useIsStandalone } from '@/lib/useIsStandalone'
import { SAVE_TIMEOUT_MS, sendRequest, type RequestOutcome } from '@/lib/save-response'

// For a reconnect whose reply was lost, timed out or could not be read (#165): the login is fixed at
// Plaid, but whether this app recorded it is not known. The reload shows whether the bank still
// needs reconnecting, and pressing Reconnect again costs nothing.
const MAY_NOT_HAVE_FINISHED = 'The reconnect may not have finished. Showing the latest.'

// Reopens Link in update mode to fix a broken login. The access token is unchanged, so on success
// completePendingLink just clears the broken flag and resyncs. Critically, update mode does NOT
// create a new Item — this is the free alternative to disconnect-and-relink, which would spend one
// of ten unrefundable slots.
//
// `onNotice` takes the route's warning that the catch-up has not arrived (#165). It is handed up
// rather than shown here: the reload after a reconnect shows the bank healthy, the list stops
// rendering this button, and anything shown beside it would go with it.
export function ReconnectButton({
  itemId,
  onNotice,
}: {
  itemId: string
  onNotice?: (notice: string | null) => void
}) {
  const router = useRouter()
  // Not from the installed app, for the reason LinkButton gives: the bank's return could land in
  // the browser, away from the pending link this app's storage holds.
  const standalone = useIsStandalone()
  const [token, setToken] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const onSuccess = useCallback(async () => {
    setBusy(true)
    let result: CompleteResult
    try {
      result = await completePendingLink('', { institution: null })
    } finally {
      setBusy(false)
      setToken(null)
    }
    if (result.outcome === 'failed') {
      setError(result.error)
      return
    }
    if (result.outcome === 'unknown') {
      setError(MAY_NOT_HAVE_FINISHED)
    } else {
      setError(null)
      onNotice?.(result.warning ?? null)
    }
    router.refresh()
  }, [router, onNotice])

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
    // nothing, since Link never opened (#165). Busy while it is in flight, so a double tap sends
    // one request.
    setBusy(true)
    let result: RequestOutcome
    try {
      result = await sendRequest(
        '/api/plaid/create-link-token',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'update', itemId }),
        },
        SAVE_TIMEOUT_MS
      )
    } finally {
      setBusy(false)
    }
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
