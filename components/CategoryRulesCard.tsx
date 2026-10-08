'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/Button'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { selectClass } from '@/components/ui/styles'
import { MAY_NOT_HAVE_SAVED, readSaveResponse } from '@/lib/save-response'
import type { Kind } from '@/lib/category-rules'
import type { RuleCounts } from '@/lib/category-views'

export type RuleView = RuleCounts & {
  id: string
  merchantLabel: string
  categoryId: string
  categoryName: string
  origin: 'seeded' | 'learned'
}
export type RuleCategory = { id: string; name: string; kind: Kind }

const ORIGIN = { seeded: 'set up from your earlier picks', learned: 'learned from a pick' } as const
const txns = (n: number) => `${n} transaction${n === 1 ? '' : 's'}`

// Settings → Category rules (#28 spec §8.3): every rule, with what it does, a Change of category
// within its kind, and Remove. Rules are created by picking (PR 3) and by the one-time seed, never
// here.
export function CategoryRulesCard({ rules, categories }: { rules: RuleView[]; categories: RuleCategory[] }) {
  const sorted = [...rules].sort((a, b) => a.merchantLabel.localeCompare(b.merchantLabel, undefined, { sensitivity: 'base' }))
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        When you pick a category for a merchant the app hasn&apos;t learned yet, it files that merchant&apos;s other
        transactions the same way, past and future. It never moves money between spending, transfers and income, and
        never touches card payments.
      </p>
      {sorted.length === 0 ? (
        <p className="text-sm text-muted">
          Nothing learned yet. Pick a category on a transaction and the app will remember it for that merchant.
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {sorted.map((r) => (
            <RuleRow key={r.id} rule={r} categories={categories} />
          ))}
        </ul>
      )}
    </div>
  )
}

function RuleRow({ rule, categories }: { rule: RuleView; categories: RuleCategory[] }) {
  const router = useRouter()
  // As CategoryPicker: the choice being saved shows until the save settles; on failure it is
  // dropped and the select falls back to the server's current value. A refresh that brings a new
  // category clears both the choice and any alert.
  const [pending, setPending] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [seen, setSeen] = useState(rule.categoryId)
  if (seen !== rule.categoryId) {
    setSeen(rule.categoryId)
    setPending(null)
    setError(null)
  }

  const current = categories.find((c) => c.id === rule.categoryId)
  // Same kind only: a rule never moves money between spending, transfers and income.
  const options = current ? categories.filter((c) => c.kind === current.kind) : []
  const label = rule.merchantLabel

  async function send(method: 'PATCH' | 'DELETE', body: Record<string, string>): Promise<boolean> {
    setBusy(true)
    setError(null)
    let reload = false
    let saved = false
    try {
      const res = await fetch('/api/category-rules', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const result = await readSaveResponse(res)
      if (result.ok) {
        saved = true
        reload = true
      } else {
        setError(result.error)
      }
    } catch (err) {
      console.error('[CategoryRulesCard] save failed', err)
      setError(MAY_NOT_HAVE_SAVED)
      reload = true
    } finally {
      setBusy(false)
    }
    if (reload) router.refresh()
    return saved
  }

  async function change(e: React.ChangeEvent<HTMLSelectElement>) {
    const categoryId = e.target.value
    setPending(categoryId)
    // No confirmation: picking again undoes it.
    const saved = await send('PATCH', { id: rule.id, categoryId, expectedCategoryId: rule.categoryId })
    if (!saved) setPending(null)
  }

  const count =
    rule.matching === 0
      ? `No current transactions · ${ORIGIN[rule.origin]}`
      : `${txns(rule.changed)}${rule.pickedByHand > 0 ? ` · ${rule.pickedByHand} picked by hand` : ''}`

  return (
    // sm:flex-wrap and the text's 19rem basis: where the row is too narrow for the longest count
    // (≈298px, "No current transactions · set up from your earlier picks") beside the controls, as
    // at 768px beside the sidebar, the controls drop to their own line instead of overlapping it.
    // The wrap also puts the alert (sm:basis-full) on a line of its own.
    <li className="flex flex-col gap-2 py-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3">
      <div className="min-w-0 sm:flex-[1_0_19rem]">
        <p className="truncate text-sm font-medium text-ink" title={label}>
          {label}
        </p>
        {/* Never inside a truncating element: the count is the point of the row. */}
        <p className="text-xs text-muted">
          <span
            className="whitespace-nowrap tabular-nums"
            title={`Transactions this rule files under ${rule.categoryName} instead of the bank's category`}
          >
            {count}
          </span>
        </p>
      </div>
      <div className="flex items-center gap-2">
        {/* md:min/max: selectClass's md:w-auto outranks a md:w-48, so the width is pinned by its bounds. */}
        <select
          value={pending ?? rule.categoryId}
          onChange={change}
          disabled={busy}
          aria-label={`Category for ${label}`}
          className={`${selectClass} min-w-0 flex-1 sm:w-48 sm:flex-none md:min-w-48 md:max-w-48`}
        >
          {options.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <Button
          variant="danger"
          size="sm"
          disabled={busy}
          onClick={() => setConfirming(true)}
          aria-label={`Remove the ${label} rule`}
        >
          Remove
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-coral sm:basis-full">
          {error}
        </p>
      )}
      <ConfirmDialog
        open={confirming}
        title={`Remove the ${label} rule?`}
        confirmLabel="Remove"
        busy={busy}
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false)
          void send('DELETE', { id: rule.id, expectedCategoryId: rule.categoryId })
        }}
      >
        {rule.changed > 0 && <p>{rule.changed} {label} transactions go back to their bank’s category.</p>}
        {rule.pickedByHand > 0 && <p>{rule.pickedByHand} you picked by hand keep theirs.</p>}
        {rule.matching === 0 && (
          <p>No {label} transactions are showing right now — for example, if a bank is disconnected.</p>
        )}
        <p>The next category you pick for {label} will teach the app again.</p>
      </ConfirmDialog>
    </li>
  )
}
