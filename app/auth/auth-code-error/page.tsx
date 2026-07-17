'use client'

import Link from 'next/link'
import { useSyncExternalStore } from 'react'
import { Card } from '@/components/ui/Card'
import { isInviteOnlyRejection } from '@/lib/authError'

// The fragment never changes while the page is mounted; there is nothing to subscribe to.
const subscribeNever = () => () => {}

export default function AuthCodeError() {
  // Supabase puts the rejection reason in the URL fragment, which only the
  // browser sees — the server snapshot is false so SSR and hydration agree,
  // then the client snapshot reads the real fragment.
  const inviteOnly = useSyncExternalStore(
    subscribeNever,
    () => isInviteOnlyRejection(window.location.hash),
    () => false
  )

  return (
    <div className="grid min-h-screen place-items-center bg-canvas px-4">
      <Card className="max-w-sm p-8 text-center">
        {inviteOnly ? (
          <>
            <h1 className="text-lg font-semibold text-ink">This app is invite-only</h1>
            <p className="mt-2 text-sm text-muted">
              It tracks one household&apos;s budget, so sign-in is limited to invited accounts.
              The code is open source, though — you can run your own copy with your own bank
              connections.
            </p>
            <a
              href="https://github.com/smilne3/every-dollar-counts#running-it-locally"
              className="mt-4 inline-block text-sm font-medium text-emerald hover:text-emerald-600"
            >
              How to run your own copy
            </a>
          </>
        ) : (
          <>
            <h1 className="text-lg font-semibold text-ink">That link didn&apos;t work</h1>
            <p className="mt-2 text-sm text-muted">
              The login link was invalid or expired. Please request a new one.
            </p>
            <Link
              href="/login"
              className="mt-4 inline-block text-sm font-medium text-emerald hover:text-emerald-600"
            >
              Back to sign in
            </Link>
          </>
        )}
      </Card>
    </div>
  )
}
