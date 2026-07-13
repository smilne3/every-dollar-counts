'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { usePlaidLink } from 'react-plaid-link'

export function LinkButton() {
  const router = useRouter()
  const [linkToken, setLinkToken] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    fetch('/api/plaid/create-link-token', { method: 'POST' })
      .then((r) => r.json())
      .then((d) => setLinkToken(d.link_token ?? null))
      .catch(() => setLinkToken(null))
  }, [])

  const onSuccess = useCallback(
    async (public_token: string, metadata: { institution?: { name?: string } | null }) => {
      setBusy(true)
      await fetch('/api/plaid/exchange-public-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          public_token,
          institution_name: metadata?.institution?.name ?? null,
        }),
      })
      setBusy(false)
      router.refresh()
    },
    [router]
  )

  const { open, ready } = usePlaidLink({ token: linkToken, onSuccess })

  return (
    <button
      onClick={() => open()}
      disabled={!ready || !linkToken || busy}
      className="rounded bg-black px-4 py-2 text-white disabled:opacity-50"
    >
      {busy ? 'Connecting…' : 'Connect a bank'}
    </button>
  )
}
