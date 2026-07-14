'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/Button'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { inputClass } from '@/components/ui/styles'

type Cat = { id: string; name: string; pfc_primary: string | null }
export type CategoryUsage = Record<string, { txns: number; hasBudget: boolean }>

export function CategoryManager({
  initialCategories,
  usage = {},
}: {
  initialCategories: Cat[]
  usage?: CategoryUsage
}) {
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
      {msg && <p className="text-sm text-emerald">{msg}</p>}
      {err && <p className="text-sm text-coral">{err}</p>}

      {initialCategories.map((c) => (
        <CategoryRow
          key={c.id}
          cat={c}
          busy={busy}
          usage={usage[c.name] ?? { txns: 0, hasBudget: false }}
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
          className={`${inputClass} flex-1`}
        />
        <Button type="submit" disabled={busy}>
          Add
        </Button>
      </form>
    </div>
  )
}

function CategoryRow({
  cat,
  busy,
  usage,
  onSave,
  onDelete,
}: {
  cat: Cat
  busy: boolean
  usage: { txns: number; hasBudget: boolean }
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
        className={`${inputClass} flex-1`}
      />
      {!cat.pfc_primary && <span className="text-xs text-faint">custom</span>}
      <Button
        variant="secondary"
        size="sm"
        disabled={busy || !changed}
        onClick={save}
        title="Save the new name"
      >
        Save
      </Button>
      <Button
        variant="danger"
        size="sm"
        disabled={busy}
        onClick={() => setConfirmDelete(true)}
        aria-label={`Delete ${cat.name}`}
      >
        Delete
      </Button>

      <ConfirmDialog
        open={confirmDelete}
        title={`Delete “${cat.name}”?`}
        busy={busy}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => {
          setConfirmDelete(false)
          onDelete()
        }}
      >
        {usage.txns > 0 ? (
          <p>
            <strong className="font-semibold text-ink">
              {usage.txns} transaction{usage.txns === 1 ? '' : 's'}
            </strong>{' '}
            will become Uncategorized.
          </p>
        ) : (
          <p>No transactions currently use this category.</p>
        )}
        {usage.hasBudget && <p>Its monthly budget will be deleted.</p>}
        <p>This can’t be undone.</p>
      </ConfirmDialog>
    </div>
  )
}
