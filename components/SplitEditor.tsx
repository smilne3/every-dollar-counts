'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { money } from '@/lib/format'
import { inputClass } from './ui/styles'
import { Button } from './ui/Button'

type ExistingSplit = { id: string; claim_id: string; owed_by: string | null; amount: number }

export function SplitEditor({
  transactionId,
  amount,
  existingSplits,
  claims,
  knownPeople,
}: {
  transactionId: string
  amount: number // signed, Plaid convention
  existingSplits: ExistingSplit[]
  claims: { id: string; name: string }[]
  knownPeople: string[]
}) {
  const router = useRouter()
  const [claimName, setClaimName] = useState(
    claims.find((c) => c.id === existingSplits[0]?.claim_id)?.name ?? ''
  )
  const [owedBy, setOwedBy] = useState('')
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const isRepayment = amount < 0
  const assigned = existingSplits.reduce((s, x) => s + x.amount, 0)
  // The live readout: for an outflow this is what actually hits your budget; for a repayment it is
  // the part that stays ordinary income.
  const remainder = Math.max(0, Math.abs(amount) - assigned)

  async function add() {
    setError(null)
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setError('Enter an amount greater than zero.')
      return
    }
    if (!claimName.trim()) {
      setError('Name what this is for.')
      return
    }
    setBusy(true)
    try {
      // Create-or-reuse the claim, then attach the split. The claims route is idempotent on name.
      const claimRes = await fetch('/api/reimbursements/claims', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: claimName.trim() }),
      })
      const claim = await claimRes.json()
      if (!claimRes.ok) {
        setError(claim.error ?? 'Could not save that claim.')
        return
      }
      const res = await fetch('/api/reimbursements/splits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transactionId,
          claimId: claim.id,
          owedBy: owedBy.trim() || null,
          amount: parsed,
        }),
      })
      const body = await res.json()
      if (!res.ok) {
        setError(body.error ?? 'Could not save that split.')
        return
      }
      setOwedBy('')
      setValue('')
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  async function remove(id: string) {
    setError(null)
    setBusy(true)
    try {
      const res = await fetch('/api/reimbursements/splits', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      })
      const body = await res.json()
      if (!res.ok) {
        // The server can refuse a delete (e.g. it would orphan a repayment, or the claim is
        // written off) — that 400 message is written for a person to read, so show it rather
        // than silently no-op'ing.
        setError(body.error ?? 'Could not remove that split.')
        return
      }
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3 rounded-lg bg-surface-2 p-4 text-sm">
      <div>
        <label htmlFor={`claim-${transactionId}`} className="block text-xs text-faint">
          What&apos;s this for?
        </label>
        <input
          id={`claim-${transactionId}`}
          list={`claims-${transactionId}`}
          value={claimName}
          onChange={(e) => setClaimName(e.target.value)}
          placeholder="e.g. Bourbon trail trip"
          className={inputClass}
        />
        <datalist id={`claims-${transactionId}`}>
          {claims.map((c) => (
            <option key={c.id} value={c.name} />
          ))}
        </datalist>
      </div>

      {existingSplits.length > 0 && (
        <ul className="space-y-1">
          {existingSplits.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-2">
              <span className="text-ink">{s.owed_by ?? 'Unattributed'}</span>
              <span className="flex items-center gap-2">
                <span className="tabular-nums text-muted">{money(s.amount)}</span>
                <button
                  type="button"
                  onClick={() => remove(s.id)}
                  disabled={busy}
                  aria-label={`Remove ${s.owed_by ?? 'unattributed'} split`}
                  className="text-faint hover:text-ink"
                >
                  ✕
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <div>
          <label htmlFor={`who-${transactionId}`} className="block text-xs text-faint">
            {isRepayment ? 'Who paid you' : 'Who owes you'}
          </label>
          <input
            id={`who-${transactionId}`}
            list={`people-${transactionId}`}
            value={owedBy}
            onChange={(e) => setOwedBy(e.target.value)}
            placeholder="e.g. Dave"
            className={inputClass}
          />
          <datalist id={`people-${transactionId}`}>
            {knownPeople.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
        </div>
        <div>
          <label htmlFor={`amt-${transactionId}`} className="block text-xs text-faint">
            Amount
          </label>
          <input
            id={`amt-${transactionId}`}
            value={value}
            inputMode="decimal"
            onChange={(e) => setValue(e.target.value)}
            placeholder="250.00"
            className={inputClass}
          />
        </div>
        <Button type="button" variant="secondary" onClick={add} disabled={busy}>
          {isRepayment ? 'Apply' : 'Add'}
        </Button>
      </div>

      {error && (
        <p role="alert" className="text-xs text-rose-600">
          {error}
        </p>
      )}

      <p className="text-xs text-faint">
        {isRepayment
          ? `Untagged (counts normally): ${money(remainder)}`
          : `Your share: ${money(remainder)}`}
      </p>
    </div>
  )
}
