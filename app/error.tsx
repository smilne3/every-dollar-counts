'use client'

import { useEffect } from 'react'
import { Card } from '@/components/ui/Card'

// The boundary above app/(app)/layout.tsx (#143). A segment's error.tsx never wraps that segment's
// own layout (Next's error.js docs), so what the layout throws passes app/(app)/error.tsx and lands
// here, inside the root layout but without the app's shell. The layout throws when Supabase Auth
// can't be asked whether the person is signed in, since sending them to /login would sign them out
// for an outage. So this says sign-in couldn't be checked, and Try again runs the check again.
//
// That check is the one server component this boundary sits over, and an error from the server
// carries a digest. Anything else that lands here crashed in the browser, on /login or /plaid/oauth
// say, with no digest, and gets plainer words. Next's own fallback tells the two apart the same way.
//
// The digest, in small print, is how a screenshot is matched to the server's log line: Next logs
// the error the layout threw with it (#130).
export default function RootError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    // As in app/(app)/error.tsx: the fail-loud path, not a place to go quiet.
    console.error(error)
  }, [error])

  // Anything can be thrown in the browser, so the digest is read only off an Error.
  const digest = error instanceof Error ? (error as Error & { digest?: string }).digest : undefined

  return (
    <div className="grid min-h-screen place-items-center bg-canvas px-4">
      <Card className="max-w-sm p-8 text-center">
        <h1 className="text-lg font-semibold text-ink">
          {digest ? "Couldn't check your sign-in" : "This page couldn't load"}
        </h1>
        <p className="mt-2 text-sm text-muted">
          {digest
            ? 'Something went wrong reaching the sign-in service. Try again, or come back in a moment.'
            : 'Something went wrong. Try again, or come back in a moment.'}
        </p>
        {digest && <p className="mt-3 text-xs text-muted">Error ID {digest}</p>}
        <button
          type="button"
          onClick={() => retry()}
          className="mt-4 inline-block text-sm font-medium text-emerald hover:text-emerald-600"
        >
          Try again
        </button>
      </Card>
    </div>
  )
}
