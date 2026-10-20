'use client'

import { useState } from 'react'
import { sendSave } from '@/lib/save-response'
import { Button } from '@/components/ui/Button'
import { inputClass, labelClass } from '@/components/ui/styles'

// For an invite whose reply never came back. Not MAY_NOT_HAVE_SAVED's "Showing the latest": nothing on
// the page lists invites, so a reload would show nothing new. Inviting again is safe, since the
// allowlist is keyed on the email.
const MAY_NOT_HAVE_INVITED = 'It may not have saved. Invite them again to be sure.'

export function InvitePartnerForm({ householdId }: { householdId: string }) {
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')

  async function invite(e: React.FormEvent) {
    e.preventDefault()
    // As on the button: Enter in the field submits the form too.
    if (busy) return
    const sent = email
    setBusy(true)
    setMsg('')
    setErr('')
    try {
      // The shared rule (lib/save-response.ts): only the route's own { ok: true } is a save. Checking
      // res.ok alone said "… can now sign in" for an invite sent after the session ended, which is
      // redirected to the login page and answers 200.
      const result = await sendSave('/api/household/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: sent, household_id: householdId }),
      })
      if (result.outcome === 'saved') {
        setMsg(`${sent} can now sign in (with Google or an email link) and will join your household.`)
        setEmail('')
      } else if (result.outcome === 'refused') {
        // What was typed stays, so trying again is one tap.
        setErr(result.error)
      } else {
        console.error('[InvitePartnerForm] save failed', result.cause)
        setErr(MAY_NOT_HAVE_INVITED)
      }
    } finally {
      // Never left on "Sending…".
      setBusy(false)
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
          aria-label="Partner's email address"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          // Fixed while an invite is in flight, so the address in "… can now sign in" is the one sent.
          disabled={busy}
        />
        <Button type="submit" disabled={busy}>
          {busy ? 'Sending…' : 'Invite'}
        </Button>
      </div>
      {msg && <p className="text-sm text-emerald">{msg}</p>}
      {err && (
        <p role="alert" className="text-sm text-coral">
          {err}
        </p>
      )}
    </form>
  )
}
