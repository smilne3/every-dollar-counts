'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { inputClass } from '@/components/ui/styles'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)

  async function google() {
    setErr('')
    const supabase = createClient()
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${location.origin}/auth/confirm` },
    })
    if (error) setErr(error.message)
  }

  async function send(e: React.FormEvent) {
    e.preventDefault()
    setErr('')
    setLoading(true)
    const supabase = createClient()
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${location.origin}/auth/confirm`, shouldCreateUser: false },
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
      <div className="grid min-h-screen place-items-center bg-canvas px-4">
        <Card className="w-full max-w-sm p-8 text-center">
          <h1 className="text-lg font-semibold text-ink">Check your email</h1>
          <p className="mt-2 text-sm text-muted">We sent a login link to {email}.</p>
        </Card>
      </div>
    )
  }

  return (
    <div className="grid min-h-screen place-items-center bg-canvas px-4">
      <Card className="w-full max-w-sm p-8">
        <div className="flex flex-col items-center text-center">
          <div className="grid h-11 w-11 place-items-center rounded-xl bg-emerald text-lg font-bold text-white">
            $
          </div>
          <h1 className="mt-4 text-xl font-semibold text-ink">Every Dollar Counts</h1>
          <p className="mt-1 text-sm text-muted">Sign in to your household budget.</p>
        </div>

        <div className="mt-6 flex flex-col gap-4">
          <Button variant="secondary" onClick={google} className="w-full">
            <span className="text-base font-bold text-[#4285F4]">G</span>
            Continue with Google
          </Button>

          <div className="flex items-center gap-3 text-xs text-faint">
            <div className="h-px flex-1 bg-line" />
            or
            <div className="h-px flex-1 bg-line" />
          </div>

          <form onSubmit={send} className="flex flex-col gap-3">
            <input
              className={inputClass}
              type="email"
              required
              placeholder="you@email.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <Button variant="primary" className="w-full" disabled={loading}>
              {loading ? 'Sending…' : 'Email me a login link'}
            </Button>
          </form>

          {err && <p className="text-sm text-coral">{err}</p>}
        </div>
      </Card>
    </div>
  )
}
