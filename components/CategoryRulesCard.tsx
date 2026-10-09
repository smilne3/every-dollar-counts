'use client'

import { Fragment, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/Button'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { selectClass } from '@/components/ui/styles'
import { MAY_NOT_HAVE_SAVED, readSaveResponse } from '@/lib/save-response'
import type { CategoryRule, Kind } from '@/lib/category-rules'
import type { RuleCounts } from '@/lib/category-views'

export type RuleView = RuleCounts & {
  id: string
  merchantLabel: string
  categoryId: string
  categoryName: string
  origin: CategoryRule['origin']
}
export type RuleCategory = { id: string; name: string; kind: Kind }

const ORIGIN: Record<CategoryRule['origin'], string> = {
  seeded: 'set up from your earlier picks',
  learned: 'learned from a pick',
}
const txns = (n: number) => `${n} transaction${n === 1 ? '' : 's'}`

// Settings → Category rules (#28 spec §8.3): every rule, with what it does, a Change of category
// within its kind, and Remove. Rules are created by picking (PR 3) and by the one-time seed, never
// here.
export function CategoryRulesCard({ rules, categories }: { rules: RuleView[]; categories: RuleCategory[] }) {
  const sorted = [...rules].sort((a, b) => a.merchantLabel.localeCompare(b.merchantLabel, undefined, { sensitivity: 'base' }))
  return (
    <div className="space-y-3">
      {/* PR 3 (#28 spec §6.1 step 8) restores the spec's wording about learning from a pick. */}
      <p className="text-sm text-muted">
        Each rule files one merchant&apos;s transactions under a category of your choosing, past and future. A rule
        never moves money between spending, transfers and income, and never touches card payments.
      </p>
      {sorted.length === 0 ? (
        <p className="text-sm text-muted">No category rules yet.</p>
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
        // 404 and 409: the server says this card is stale, so show the latest under the message.
        reload = result.status === 404 || result.status === 409
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

  const countParts =
    rule.matching === 0
      ? ['No current transactions', ORIGIN[rule.origin]]
      : [txns(rule.changed), ...(rule.pickedByHand > 0 ? [`${rule.pickedByHand} picked by hand`] : [])]

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
        {/* Each piece is unbreakable and the line breaks only after a " ·": the longest line is wider
            than a 360px phone's content box, so it wraps there rather than overflowing. */}
        <p
          className="text-xs text-muted"
          title={`Transactions this rule files under ${rule.categoryName} instead of the bank's category`}
        >
          {countParts.map((part, i) => (
            <Fragment key={i}>
              {i > 0 && ' '}
              <span className="whitespace-nowrap tabular-nums">
                {part}
                {i < countParts.length - 1 && ' ·'}
              </span>
            </Fragment>
          ))}
        </p>
      </div>
      {current ? (
        <div className="flex items-center gap-2">
          {/* sm:w-48 sets 192px from sm, but from md selectClass's md:w-auto outranks it, so
              md:min-w-48 and md:max-w-48 pin the select at 192px there. */}
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
      ) : (
        // The FK deletes a rule with its category, so this rule raced a delete: nothing to change.
        // No #category-rules on the link: from /settings a hash-only change scrolls, it does not reload.
        <p className="text-xs text-muted">
          This category was just deleted.{' '}
          <a href="/settings" className="font-medium underline">
            Reload the page.
          </a>
        </p>
      )}
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
        {rule.changed === 1 && <p>1 {label} transaction goes back to its bank’s category.</p>}
        {rule.changed > 1 && <p>{rule.changed} {label} transactions go back to their bank’s category.</p>}
        {rule.pickedByHand === 1 && <p>1 you picked by hand keeps its category.</p>}
        {rule.pickedByHand > 1 && <p>{rule.pickedByHand} you picked by hand keep theirs.</p>}
        {rule.matching === 0 && (
          <p>No {label} transactions are showing right now — for example, if a bank is disconnected.</p>
        )}
      </ConfirmDialog>
    </li>
  )
}
