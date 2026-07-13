'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { CATEGORIES, label } from '@/lib/categories'

export function CategoryPicker({ transactionId, value }: { transactionId: string; value: string }) {
  const router = useRouter()
  const [val, setVal] = useState(value)
  const [saving, setSaving] = useState(false)

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
      {CATEGORIES.map((c) => (
        <option key={c} value={c}>
          {label(c)}
        </option>
      ))}
    </select>
  )
}
