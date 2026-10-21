import Link from 'next/link'
import { Card } from '@/components/ui/Card'

// Where app/auth/confirm/route.ts sends someone whose sign-in it could not finish because Supabase
// Auth could not be asked (#143). Nothing showed they aren't invited, so they are not told that,
// and nothing showed the link was bad. Signing in again finishes it, a first sign-in's invite
// included.
export default function SignInTryAgain() {
  return (
    <div className="grid min-h-screen place-items-center bg-canvas px-4">
      <Card className="max-w-sm p-8 text-center">
        <h1 className="text-lg font-semibold text-ink">Sign-in couldn&apos;t be completed</h1>
        <p className="mt-2 text-sm text-muted">
          Something went wrong reaching the sign-in service. Try again, or come back in a moment.
        </p>
        <Link
          href="/login"
          className="mt-4 inline-block text-sm font-medium text-emerald hover:text-emerald-600"
        >
          Back to sign in
        </Link>
      </Card>
    </div>
  )
}
