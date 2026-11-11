'use client'

import { Fragment, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/Button'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { inputClass } from '@/components/ui/styles'
import type { DeleteImpact } from '@/lib/category-views'
import { MAY_NOT_HAVE_SAVED, sendSave } from '@/lib/save-response'

type Cat = { id: string; name: string; pfc_primary: string | null }
export type CategoryUsage = Record<string, { txns: number; hasBudget: boolean; impact: DeleteImpact }>

const NO_USAGE: CategoryUsage[string] = {
  txns: 0,
  hasBudget: false,
  impact: { uncategorized: 0, moved: [], movedMore: 0, rulesRemoved: 0, toSpending: 0 },
}

// A save's message shows under the row it came from, or under the add box (`row: null`). It used to
// show at the top of the list, which on a phone is a long scroll above the add box, so a refusal
// looked like nothing happened (#253). `index` is where the row was, for when the row is gone.
type Note = { text: string; ok: boolean; row: { id: string; index: number } | null }

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
  const [note, setNote] = useState<Note | null>(null)
  // Bumped after a save whose outcome is unknown, so every row drops what was typed and shows the
  // server's name, as "Showing the latest" says. See the rows' key below.
  const [resets, setResets] = useState(0)

  // Add, rename and delete all save through here (#147). True only when the route said it saved.
  async function call(method: 'POST' | 'PATCH' | 'DELETE', body: unknown, okMsg: string, row: Note['row']): Promise<boolean> {
    setBusy(true)
    setNote(null)
    let reload = false
    let saved = false
    try {
      // The shared rule (lib/save-response.ts): only the route's own { ok: true } is a save.
      const result = await sendSave('/api/categories', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (result.outcome === 'saved') {
        saved = true
        setNote({ text: okMsg, ok: true, row })
        reload = true
      } else if (result.outcome === 'refused') {
        setNote({ text: result.error, ok: false, row })
        // 404: the list is stale (a category deleted on the other phone, say), so reload to show the
        // latest. 409 is a name another category has, perhaps one added on the other phone
        // or by an add whose reply was lost (#246), so the reload shows it. Or it's the route's
        // environment guard (#148), which wrote nothing, so the reload shows the same list.
        reload = result.status === 404 || result.status === 409
      } else {
        console.error('[CategoryManager] save failed', result.cause)
        setNote({ text: MAY_NOT_HAVE_SAVED, ok: false, row })
        setResets((n) => n + 1)
        reload = true
      }
    } finally {
      // Never left with every button disabled.
      setBusy(false)
    }
    // Outside the try: a throw from refresh is not a failed save.
    if (reload) router.refresh()
    return saved
  }

  const shown =
    note &&
    (note.ok ? (
      <p className="text-sm text-emerald">{note.text}</p>
    ) : (
      <p role="alert" className="text-sm text-coral">
        {note.text}
      </p>
    ))
  // A row that's gone, deleted here or on the other phone, leaves its message in its place: above the
  // row that moved up, or after the last.
  const row = note?.row
  const goneAt = row && !initialCategories.some((c) => c.id === row.id) ? row.index : -1

  return (
    <div className="space-y-2">
      {initialCategories.map((c, i) => (
        <Fragment
          // A row fills its field from the server's name once, when it mounts, so the key holds what
          // must refill it: a new name from the server (renamed on the other phone, or a rename that
          // landed) or a save whose outcome is unknown. A refusal changes neither, so what was typed
          // stays for another try.
          key={`${c.id}:${c.name}:${resets}`}
        >
          {goneAt === i && shown}
          <CategoryRow
            cat={c}
            busy={busy}
            usage={usage[c.name] ?? NO_USAGE}
            onSave={(name) => call('PATCH', { id: c.id, name }, `Renamed to “${name}”.`, { id: c.id, index: i })}
            onDelete={() => call('DELETE', { id: c.id }, `Deleted “${c.name}”.`, { id: c.id, index: i })}
          />
          {row?.id === c.id && shown}
        </Fragment>
      ))}
      {goneAt >= initialCategories.length && shown}

      <form
        className="flex flex-wrap gap-2 pt-3 md:max-w-md md:flex-nowrap"
        onSubmit={async (e) => {
          e.preventDefault()
          const n = newName.trim()
          if (!n) return
          // Cleared only once it saved (#147): cleared before the reply, a failed add lost what was
          // typed. And only if the field still holds that name, so one typed meanwhile stays.
          if (await call('POST', { name: n }, `Added “${n}”.`, null)) {
            setNewName((current) => (current.trim() === n ? '' : current))
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
      {note && !note.row && shown}
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

  // `busy` here as well as on the Save button: Enter in the field calls this too, and a rename sent
  // while another save is in flight would race it (#147).
  function save() {
    if (changed && !busy) onSave(name.trim())
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
          {impact.rulesRemoved} merchant {impact.rulesRemoved === 1 ? 'rule that files' : 'rules that file'} into{' '}
          {name} will be removed.
        </p>
      )}
      {impact.toSpending > 0 && <p>{impact.toSpending} of these will start counting as spending.</p>}
    </>
  )
}
