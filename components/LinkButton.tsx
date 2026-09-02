'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { usePlaidLink } from 'react-plaid-link'
import { buttonClass } from '@/components/ui/Button'
import { BankIcon } from '@/components/ui/icons'
import {
  savePendingLink,
  clearPendingLink,
  completePendingLink,
} from '@/components/plaid-link-context'

// Two paths, because Plaid Link only lists institutions supporting EVERY requested product:
// asking for transactions + investments at once would hide most banks AND most brokerages.
//
// There is deliberately no third "loan" button. The household's mortgage is at Wells Fargo, which
// supports `transactions`, so it appears in the ordinary bank flow inside the same login — no
// extra Item slot. A dedicated button only pays for itself with a servicer you don't also bank at.

// An error carries whether a bank connection was actually at stake. Nothing is created until the
// user finishes at their bank, so a failure while we are still fetching the link token cannot have
// spent a slot — and pairing the server's "Nothing was connected." with a warning that "every new
// attempt uses one of your ten bank connections permanently" would contradict it and scare the
// user off a retry that is genuinely free. One object rather than two states, so the flag cannot
// drift away from the message it describes.
type LinkError = { message: string; slotAtRisk: boolean }

export function LinkButton() {
  const router = useRouter()
  const [token, setToken] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<LinkError | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const onSuccess = useCallback(
    async (public_token: string, metadata: { institution?: { name?: string } | null }) => {
      setBusy(true)
      const result = await completePendingLink(public_token, metadata)
      setBusy(false)
      setToken(null)
      if (!result.ok) {
        // Loud on purpose: the Plaid connection already exists at this point, so a silent failure
        // invites a retry that spends another unrefundable slot.
        setError({ message: result.error, slotAtRisk: true })
        return
      }
      setError(null)
      setNotice(result.warning ?? null)
      router.refresh()
    },
    [router]
  )

  // Link reports cancellation and bank-side failures through onExit, never by throwing.
  const onExit = useCallback((err: { display_message?: string | null } | null) => {
    clearPendingLink()
    setBusy(false)
    setToken(null)
    // Link opened, so treat the slot as at risk: only the bank knows how far the user got.
    if (err) {
      setError({
        message: err.display_message ?? "That didn't finish. Nothing was connected.",
        slotAtRisk: true,
      })
    }
  }, [])

  const { open, ready } = usePlaidLink({ token, onSuccess, onExit })

  // A token arrives only after the user picked a variant; open Link as soon as it's ready.
  useEffect(() => {
    if (token && ready) open()
  }, [token, ready, open])

  const start = useCallback(async (products: string[]) => {
    setError(null)
    setNotice(null)
    let body: { link_token?: string; error?: string } = {}
    try {
      const res = await fetch('/api/plaid/create-link-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'add', products }),
      })
      body = await res.json().catch(() => ({}))
      if (!res.ok || !body.link_token) {
        // No link token means Link never opened, so no Item exists and no slot is at risk —
        // including the environment guard's 409/500, which says "Nothing was connected."
        setError({
          message: body.error ?? "Couldn't start the connection. Please try again.",
          slotAtRisk: false,
        })
        return
      }
    } catch {
      setError({
        message: "Couldn't reach the app. Check your connection, then try again.",
        slotAtRisk: false,
      })
      return
    }
    savePendingLink({ token: body.link_token, mode: 'add', products })
    setToken(body.link_token)
  }, [])

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => start(['transactions'])}
          disabled={busy}
          className={buttonClass('primary', 'md')}
        >
          <BankIcon className="h-[18px] w-[18px]" />
          {busy ? 'Connecting…' : 'Connect a bank'}
        </button>
        <button
          onClick={() => start(['investments'])}
          disabled={busy}
          className={buttonClass('secondary', 'md')}
        >
          Add investment account
        </button>
      </div>
      {error && (
        <p className="text-sm text-coral">
          {error.message}
          {error.slotAtRisk &&
            ' Check the list above before trying again — every new attempt uses one of your ten bank connections permanently.'}
        </p>
      )}
      {notice && <p className="text-sm text-muted">{notice}</p>}
    </div>
  )
}
