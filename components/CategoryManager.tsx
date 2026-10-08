'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/Button'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { inputClass } from '@/components/ui/styles'
import type { DeleteImpact } from '@/lib/category-views'

type Cat = { id: string; name: string; pfc_primary: string | null }
export type CategoryUsage = Record<string, { txns: number; hasBudget: boolean; impact: DeleteImpact }>

const NO_USAGE: CategoryUsage[string] = {
  txns: 0,
  hasBudget: false,
  impact: { uncategorized: 0, moved: [], movedMore: 0, rulesRemoved: 0, toSpending: 0 },
}

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
          usage={usage[c.name] ?? NO_USAGE}
          onSave={(name) => call('PATCH', { id: c.id, name }, `Renamed to “${name}”.`)}
          onDelete={() => call('DELETE', { id: c.id }, `Deleted “${c.name}”.`)}
        />
      ))}

      <form
        className="flex flex-wrap gap-2 pt-3 md:max-w-md md:flex-nowrap"
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
          aria-label="New category name"
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
  usage: CategoryUsage[string]
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
    <div data-category-row className="flex flex-wrap items-center gap-2 md:max-w-md md:flex-nowrap">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        aria-label={`Rename category ${cat.name}`}
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
        <DeleteImpactLines name={cat.name} impact={usage.impact} />
        {usage.hasBudget && <p>Its monthly budget will be deleted.</p>}
        <p>This can’t be undone.</p>
      </ConfirmDialog>
    </div>
  )
}

const txns = (n: number) => `${n} transaction${n === 1 ? '' : 's'}`

// What deleting this category would actually do (#28 spec §8.4), from deleteImpact. It used to say
// every row "will become Uncategorized", which was wrong for hand picks (they take their merchant's
// rule, or their bank category) and would be wrong again for rule-labelled rows.
function DeleteImpactLines({ name, impact }: { name: string; impact: DeleteImpact }) {
  const moving = impact.uncategorized + impact.moved.reduce((s, m) => s + m.count, 0) + impact.movedMore
  return (
    <>
      {moving === 0 && <p>No transactions currently use this category.</p>}
      {impact.uncategorized > 0 && (
        <p>
          <strong className="font-semibold text-ink">{txns(impact.uncategorized)}</strong> will become Uncategorized.
        </p>
      )}
      {impact.moved.map((m) => (
        <p key={m.name}>
          <strong className="font-semibold text-ink">{txns(m.count)}</strong> will move to {m.name}.
        </p>
      ))}
      {impact.movedMore > 0 && <p>And {impact.movedMore} more will move to other categories.</p>}
      {impact.rulesRemoved > 0 && (
        <p>
          {impact.rulesRemoved} merchant rule{impact.rulesRemoved === 1 ? '' : 's'} that file into {name} will be
          removed.
        </p>
      )}
      {impact.toSpending > 0 && <p>{impact.toSpending} of these will start counting as spending.</p>}
    </>
  )
}
