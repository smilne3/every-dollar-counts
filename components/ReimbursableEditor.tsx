'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { money } from '@/lib/format'
import { inputClass } from './ui/styles'

export function ReimbursableEditor({
  transactionId,
  amount,
  reimbursableAmount,
  note,
}: {
  transactionId: string
  amount: number
  reimbursableAmount: number | null
  note: string | null
}) {
  const router = useRouter()
  const full = Math.abs(amount)
  const [value, setValue] = useState(String(reimbursableAmount ?? ''))
  const [memo, setMemo] = useState(note ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save(next: number | null) {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/reimbursable', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transactionId, amount: next, note: memo }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setError(body.error ?? 'That could not be saved.')
        return
      }
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-2 text-left">
      <label className="text-xs text-muted">
        How much of {money(full)} is coming back?
        <input
          type="number"
          step="0.01"
          min="0"
          // The route clamps too, and the DB CHECK is the real guarantee. This is only so the field
          // does not invite a number that would come straight back as an error.
          max={full}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className={inputClass}
        />
      </label>
      <label className="text-xs text-muted">
        Note (optional)
        <input
          type="text"
          value={memo}
          onChange={(e) => setMemo(e.target.value)}
          placeholder="Dave, Sam, Priya"
          className={inputClass}
        />
      </label>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => save(value === '' ? null : Number(value))}
          className="text-xs font-medium text-emerald hover:text-emerald-600 disabled:opacity-50"
        >
          Save
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => save(null)}
          className="text-xs font-medium text-muted hover:text-ink disabled:opacity-50"
        >
          Clear
        </button>
      </div>
      {error && (
        <span role="alert" className="text-xs text-coral">
          {error}
        </span>
      )}
    </div>
  )
}
