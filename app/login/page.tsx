'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)

  async function send(e: React.FormEvent) {
    e.preventDefault()
    setErr('')
    setLoading(true)
    const supabase = createClient()
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${location.origin}/auth/confirm`,
        shouldCreateUser: false, // invite-only
      },
    })
    setLoading(false)
    if (error) {
      const status = (error as { status?: number }).status
      if (status === 429 || /rate limit/i.test(error.message)) {
        setErr('Too many login emails in a short time. Please wait a few minutes and try again.')
      } else if (/not allowed|signups? not allowed|not authorized/i.test(error.message)) {
        setErr('That email is not invited to a household yet.')
      } else {
        setErr(error.message || 'Sorry, we could not send your login link. Please try again.')
      }
    } else {
      setSent(true)
    }
  }

  if (sent) {
    return (
      <div className="mx-auto mt-24 max-w-sm p-6 text-center">
        <h1 className="text-xl font-semibold">Check your email</h1>
        <p className="mt-2 text-gray-600">We sent a login link to {email}.</p>
      </div>
    )
  }

  return (
    <form onSubmit={send} className="mx-auto mt-24 flex max-w-sm flex-col gap-3 p-6">
      <h1 className="text-xl font-semibold">Every Dollar Counts</h1>
      <p className="text-sm text-gray-600">Sign in with a one-time email link.</p>
      <input
        className="rounded border p-2"
        type="email"
        required
        placeholder="you@email.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <button
        className="rounded bg-black p-2 text-white disabled:opacity-50"
        disabled={loading}
      >
        {loading ? 'Sending…' : 'Email me a login link'}
      </button>
      {err && <p className="text-sm text-red-600">{err}</p>}
    </form>
  )
}
