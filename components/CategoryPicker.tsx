'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export function CategoryPicker({
  transactionId,
  value,
  options,
}: {
  transactionId: string
  value: string
  options: string[]
}) {
  const router = useRouter()
  const [val, setVal] = useState(value)
  const [saving, setSaving] = useState(false)

  // Ensure the current value is selectable even if it's 'Uncategorized' or stale.
  const opts = options.includes(val) ? options : [val, ...options]

  async function change(e: React.ChangeEvent<HTMLSelectElement>) {
    const category = e.target.value
    setVal(category)
    setSaving(true)
    await fetch('/api/transactions/categorize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transactionId, category }),
    })
    setSaving(false)
    router.refresh()
  }

  return (
    <select
      value={val}
      onChange={change}
      disabled={saving}
      className="rounded border px-2 py-1 text-sm disabled:opacity-50"
    >
      {opts.map((c) => (
        <option key={c} value={c}>
          {c}
        </option>
      ))}
    </select>
  )
}
