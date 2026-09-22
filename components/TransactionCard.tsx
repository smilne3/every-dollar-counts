'use client'

import { useState } from 'react'
import { money } from '@/lib/format'
import { presentTransaction, TONE_CLASS } from '@/lib/transaction-presentation'

type Txn = {
  id: string
  date: string
  name: string | null
  merchant_name: string | null
  amount: number
  user_category: string | null
  pfc_detailed: string | null
  reimbursable_amount: number | null
  reimbursable_note: string | null
}

// The phone presentation of one transaction. Takes the same three props as TransactionRow so the
// page can map one list with either, and derives every displayed value from presentTransaction so
// the two cannot disagree about what the transaction is.
export function TransactionCard({
  t,
  categoryName,
}: {
  t: Txn
  categoryName: string
  categoryOptions: string[]
}) {
  const [open, setOpen] = useState(false)
  const { label, display, tone, isCC, shareAmount } = presentTransaction(t)
  const name = label ?? 'Transaction'

  // The whole row is the control: a 390px row has no room for a separate affordance, and the
  // sheet is the only place the category and reimbursable controls fit (spec §3.2).
  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      aria-label={`${name}, ${money(display)} — edit`}
      className="flex w-full items-start justify-between gap-3 border-b border-line px-4 py-3 text-left transition-colors last:border-b-0 active:bg-surface-2"
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-ink">{name}</span>
        <span className="mt-0.5 block truncate text-xs text-muted">
          {t.date} · {isCC ? 'Card payment' : categoryName}
          {shareAmount !== null && ` · your share ${money(shareAmount)}`}
        </span>
      </span>
      <span className={`shrink-0 font-medium tabular-nums ${TONE_CLASS[tone]}`}>{money(display)}</span>
    </button>
  )
}
