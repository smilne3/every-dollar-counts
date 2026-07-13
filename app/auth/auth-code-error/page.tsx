import Link from 'next/link'

export default function AuthCodeError() {
  return (
    <div className="mx-auto mt-24 max-w-sm p-6 text-center">
      <h1 className="text-xl font-semibold">That link didn&apos;t work</h1>
      <p className="mt-2 text-gray-600">
        The login link was invalid or expired. Please request a new one.
      </p>
      <Link href="/login" className="mt-4 inline-block rounded bg-black px-4 py-2 text-white">
        Back to sign in
      </Link>
    </div>
  )
}
