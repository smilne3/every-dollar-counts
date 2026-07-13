'use client'

import { useState } from 'react'

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
      setMsg(`Invite sent to ${email}.`)
      setEmail('')
    } else {
      const { error } = await res.json().catch(() => ({ error: 'Something went wrong' }))
      setStatus('error')
      setMsg(error)
    }
  }

  return (
    <form onSubmit={invite} className="flex max-w-sm flex-col gap-2">
      <label className="text-sm font-medium">Invite your partner</label>
      <div className="flex gap-2">
        <input
          className="flex-1 rounded border p-2"
          type="email"
          required
          placeholder="partner@email.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <button
          className="rounded bg-black px-4 py-2 text-white disabled:opacity-50"
          disabled={status === 'sending'}
        >
          {status === 'sending' ? 'Sending…' : 'Invite'}
        </button>
      </div>
      {msg && (
        <p className={`text-sm ${status === 'error' ? 'text-red-600' : 'text-green-700'}`}>{msg}</p>
      )}
    </form>
  )
}
