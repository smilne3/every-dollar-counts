'use client'

import { useState } from 'react'
import { money } from '@/lib/format'
import { CategoryPicker } from './CategoryPicker'
import { SplitEditor } from './SplitEditor'

type Txn = {
  id: string
  date: string
  name: string | null
  merchant_name: string | null
  amount: number
}

type ExistingSplit = { id: string; claim_id: string; owed_by: string | null; amount: number }

export function TransactionRow({
  t,
  categoryName,
  categoryOptions,
  splits,
  claims,
  knownPeople,
}: {
  t: Txn
  categoryName: string
  categoryOptions: string[]
  splits: ExistingSplit[]
  claims: { id: string; name: string }[]
  knownPeople: string[]
}) {
  const [open, setOpen] = useState(false)
  // Plaid: amount > 0 means money OUT. Show spending as negative.
  const display = -t.amount
  const assigned = splits.reduce((s, x) => s + x.amount, 0)
  // What this row actually contributes once reimbursables are removed — shown alongside the real
  // bank amount so the row still reconciles with the statement.
  const share = Math.max(0, Math.abs(t.amount) - assigned)
  const label = t.merchant_name ?? t.name

  return (
    <>
      <tr className="border-b border-line transition-colors hover:bg-surface-2">
        <td className="px-4 py-3 whitespace-nowrap text-sm text-muted">{t.date}</td>
        <td className="px-4 py-3 font-medium text-ink">{label}</td>
        <td className="px-4 py-3">
          <CategoryPicker
            transactionId={t.id}
            value={categoryName}
            options={categoryOptions}
            label={label ?? undefined}
          />
        </td>
        <td
          className={`px-4 py-3 text-right font-medium tabular-nums ${display < 0 ? 'text-ink' : 'text-emerald'}`}
        >
          {money(display)}
          {assigned > 0 && (
            <span className="block text-xs font-normal text-faint">
              {/* An outflow's share is money out (shown negative); an inflow's untagged remainder is
                  money in (shown positive) — matching the `display` convention above. */}
              your share {money(t.amount < 0 ? share : -share)}
            </span>
          )}
        </td>
        <td className="px-4 py-3 text-right">
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-label={`Split ${label ?? 'transaction'}`}
            className="text-xs font-medium text-emerald hover:text-emerald-600"
          >
            {assigned > 0 ? 'Splits' : 'Split'}
          </button>
        </td>
      </tr>
      {open && (
        <tr className="border-b border-line">
          <td colSpan={5} className="px-4 pb-4">
            <SplitEditor
              transactionId={t.id}
              amount={t.amount}
              existingSplits={splits}
              claims={claims}
              knownPeople={knownPeople}
            />
          </td>
        </tr>
      )}
    </>
  )
}
