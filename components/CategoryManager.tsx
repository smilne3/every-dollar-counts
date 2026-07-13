'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

type Cat = { id: string; name: string; pfc_primary: string | null }

export function CategoryManager({ initialCategories }: { initialCategories: Cat[] }) {
  const router = useRouter()
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)

  async function call(method: string, body: unknown) {
    setBusy(true)
    await fetch('/api/categories', {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    setBusy(false)
    router.refresh()
  }

  return (
    <div className="space-y-2">
      {initialCategories.map((c) => (
        <CategoryRow
          key={c.id}
          cat={c}
          busy={busy}
          onRename={(name) => call('PATCH', { id: c.id, name })}
          onDelete={() => call('DELETE', { id: c.id })}
        />
      ))}
      <form
        className="flex max-w-md gap-2 pt-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (newName.trim()) {
            call('POST', { name: newName.trim() })
            setNewName('')
          }
        }}
      >
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="New category (e.g. Kids, Pets)…"
          className="flex-1 rounded border p-2 text-sm"
        />
        <button disabled={busy} className="rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-50">
          Add
        </button>
      </form>
    </div>
  )
}

function CategoryRow({
  cat,
  busy,
  onRename,
  onDelete,
}: {
  cat: Cat
  busy: boolean
  onRename: (name: string) => void
  onDelete: () => void
}) {
  const [name, setName] = useState(cat.name)
  const changed = name.trim() !== cat.name && name.trim().length > 0
  return (
    <div className="flex max-w-md items-center gap-2">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="flex-1 rounded border p-1.5 text-sm"
      />
      {!cat.pfc_primary && <span className="text-xs text-gray-400">custom</span>}
      <button
        disabled={busy || !changed}
        onClick={() => onRename(name.trim())}
        className="rounded border px-2 py-1 text-xs disabled:opacity-40"
      >
        Rename
      </button>
      <button
        disabled={busy}
        onClick={onDelete}
        className="rounded border px-2 py-1 text-xs text-red-600 disabled:opacity-40"
      >
        Delete
      </button>
    </div>
  )
}
