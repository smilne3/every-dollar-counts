import Link from 'next/link'
import { Card } from '@/components/ui/Card'

export default function NotInvited() {
  return (
    <div className="grid min-h-screen place-items-center bg-canvas px-4">
      <Card className="max-w-sm p-8 text-center">
        <h1 className="text-lg font-semibold text-ink">Not invited yet</h1>
        <p className="mt-2 text-sm text-muted">
          This account isn&apos;t part of a household. Ask the household owner to invite your email
          address, then sign in again.
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
