'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { usePlaidLink } from 'react-plaid-link'
import {
  loadPendingLink,
  clearPendingLink,
  completePendingLink,
} from '@/components/plaid-link-context'

// Where an OAuth bank (Wells Fargo, Chase, BofA…) sends the user back to. Re-initialize Link with
// the SAME token we saved before redirecting, plus receivedRedirectUri, and Link resumes and fires
// onSuccess here.
//
// The token is read DURING RENDER, not in an effect. React 19's `react-hooks/set-state-in-effect`
// rule makes `useEffect(() => setToken(...), [])` a hard lint ERROR — and `next build` no longer
// runs ESLint, so that mistake would ship and surface much later. The SSR guard inside
// loadPendingLink is what makes a render-time read safe during prerendering.
export default function PlaidOAuthPage() {
  const router = useRouter()
  const [token] = useState<string | null>(() => loadPendingLink()?.token ?? null)
  const [error, setError] = useState<string | null>(null)

  const onSuccess = useCallback(
    async (public_token: string, metadata: { institution?: { name?: string } | null }) => {
      const result = await completePendingLink(public_token, metadata)
      if (!result.ok) {
        setError(result.error)
        return
      }
      router.replace('/dashboard')
    },
    [router]
  )

  const onExit = useCallback((err: { display_message?: string | null } | null) => {
    clearPendingLink()
    setError(err?.display_message ?? "That didn't finish.")
  }, [])

  const { open, ready } = usePlaidLink({
    token,
    receivedRedirectUri: typeof window !== 'undefined' ? window.location.href : undefined,
    onSuccess,
    onExit,
  })

  useEffect(() => {
    if (token && ready) open()
  }, [token, ready, open])

  // No saved context: an expired attempt, a different browser, or a private window. Never leave
  // the user on a spinner that cannot resolve — the bank connection may already exist at Plaid,
  // and a spinner is exactly what makes someone give up and link a second time.
  if (!token || error) {
    return (
      <div className="grid min-h-screen place-items-center bg-canvas px-4">
        <div className="max-w-sm space-y-3 text-center">
          <h1 className="text-lg font-semibold text-ink">We couldn&apos;t finish that connection</h1>
          <p className="text-sm text-muted">
            {error ?? 'That attempt expired, or it was started in a different browser.'}
          </p>
          <p className="text-sm text-muted">
            Check Settings before trying again — if the bank is listed there, it worked. Every fresh
            attempt uses one of your ten bank connections permanently.
          </p>
          <Link
            href="/settings"
            className="inline-block text-sm font-medium text-emerald hover:text-emerald-600"
          >
            Go to Settings
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="grid min-h-screen place-items-center bg-canvas px-4">
      <p className="text-sm text-muted">Finishing up your bank connection…</p>
    </div>
  )
}
