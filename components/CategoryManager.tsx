'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

type Cat = { id: string; name: string; pfc_primary: string | null }

export function CategoryManager({ initialCategories }: { initialCategories: Cat[] }) {
  const router = useRouter()
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')

  async function call(method: string, body: unknown, okMsg: string) {
    setBusy(true)
    setMsg('')
    setErr('')
    const res = await fetch('/api/categories', {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    setBusy(false)
    if (res.ok) {
      setMsg(okMsg)
      router.refresh()
    } else {
      const e = await res.json().catch(() => ({}))
      setErr(e.error || 'Something went wrong. Please try again.')
    }
  }

  return (
    <div className="space-y-2">
      {msg && <p className="text-sm text-green-700">{msg}</p>}
      {err && <p className="text-sm text-red-600">{err}</p>}

      {initialCategories.map((c) => (
        <CategoryRow
          key={c.id}
          cat={c}
          busy={busy}
          onSave={(name) => call('PATCH', { id: c.id, name }, `Renamed to “${name}”.`)}
          onDelete={() => call('DELETE', { id: c.id }, `Deleted “${c.name}”.`)}
        />
      ))}

      <form
        className="flex max-w-md gap-2 pt-3"
        onSubmit={(e) => {
          e.preventDefault()
          const n = newName.trim()
          if (n) {
            call('POST', { name: n }, `Added “${n}”.`)
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
  onSave,
  onDelete,
}: {
  cat: Cat
  busy: boolean
  onSave: (name: string) => void
  onDelete: () => void
}) {
  const [name, setName] = useState(cat.name)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const changed = name.trim().length > 0 && name.trim() !== cat.name

  function save() {
    if (changed) onSave(name.trim())
  }

  return (
    <div className="flex max-w-md items-center gap-2">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            save()
          }
        }}
        className="flex-1 rounded border p-1.5 text-sm"
      />
      {!cat.pfc_primary && <span className="text-xs text-gray-400">custom</span>}
      <button
        disabled={busy || !changed}
        onClick={save}
        className="rounded border px-2 py-1 text-xs disabled:opacity-40"
        title="Save the new name"
      >
        Save
      </button>
      {confirmDelete ? (
        <button
          disabled={busy}
          onClick={onDelete}
          className="rounded border border-red-600 bg-red-600 px-2 py-1 text-xs text-white disabled:opacity-40"
        >
          Confirm
        </button>
      ) : (
        <button
          disabled={busy}
          onClick={() => setConfirmDelete(true)}
          onBlur={() => setConfirmDelete(false)}
          className="rounded border px-2 py-1 text-xs text-red-600 disabled:opacity-40"
        >
          Delete
        </button>
      )}
    </div>
  )
}
