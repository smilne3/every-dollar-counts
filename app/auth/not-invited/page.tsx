import Link from 'next/link'

export default function NotInvited() {
  return (
    <div className="mx-auto mt-24 max-w-sm p-6 text-center">
      <h1 className="text-xl font-semibold">Not invited yet</h1>
      <p className="mt-2 text-gray-600">
        This account isn&apos;t part of a household. Ask the household owner to invite your email
        address, then sign in again.
      </p>
      <Link href="/login" className="mt-4 inline-block rounded bg-black px-4 py-2 text-white">
        Back to sign in
      </Link>
    </div>
  )
}
