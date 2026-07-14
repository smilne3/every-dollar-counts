'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/Button'
import { inputClass, labelClass } from '@/components/ui/styles'

export function InvitePartnerForm({ householdId }: { householdId: string }) {
  const [email, setEmail] = useState('')
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')
  const [msg, setMsg] = useState('')

  async function invite(e: React.FormEvent) {
    e.preventDefault()
    setStatus('sending')
    setMsg('')
    const res = await fetch('/api/household/invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, household_id: householdId }),
    })
    if (res.ok) {
      setStatus('sent')
      setMsg(`${email} can now sign in (with Google or an email link) and will join your household.`)
      setEmail('')
    } else {
      const { error } = await res.json().catch(() => ({ error: 'Something went wrong' }))
      setStatus('error')
      setMsg(error)
    }
  }

  return (
    <form onSubmit={invite} className="flex max-w-sm flex-col gap-2">
      <label className={labelClass}>Invite your partner</label>
      <div className="flex gap-2">
        <input
          className={`${inputClass} flex-1`}
          type="email"
          required
          placeholder="partner@email.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Button type="submit" disabled={status === 'sending'}>
          {status === 'sending' ? 'Sending…' : 'Invite'}
        </Button>
      </div>
      {msg && (
        <p className={`text-sm ${status === 'error' ? 'text-coral' : 'text-emerald'}`}>{msg}</p>
      )}
    </form>
  )
}
