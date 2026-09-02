import { money } from '@/lib/format'
import { isCreditCardPayment } from '@/lib/categories'
import { CategoryPicker } from './CategoryPicker'
import { ReimbursableCheckbox } from './ReimbursableCheckbox'
import { ReimbursableEditor } from './ReimbursableEditor'

type Txn = {
  id: string
  date: string
  name: string | null
  merchant_name: string | null
  amount: number
  // What identify a credit-card payment, which the reimbursable route refuses, so the checkbox must
  // not be offered on one. Both are already selected by the page.
  user_category: string | null
  pfc_detailed: string | null
  reimbursable_amount: number | null
  reimbursable_note: string | null
}

export function TransactionRow({
  t,
  categoryName,
  categoryOptions,
}: {
  t: Txn
  categoryName: string
  categoryOptions: string[]
}) {
  // Plaid: amount > 0 means money OUT. Show spending as negative.
  const display = -t.amount
  const marked = Number(t.reimbursable_amount ?? 0)
  // What this row actually contributes once the reimbursable mark is removed — shown alongside the
  // real bank amount so the row still reconciles with the statement.
  const share = Math.max(0, Math.abs(t.amount) - marked)
  const label = t.merchant_name ?? t.name
  // Guards #31, same as ReimbursableCheckbox: the route refuses credit-card payments, so the partial
  // editor must not be offered on one either — reuse the one predicate rather than
  // letting a second copy drift from it.
  const isCC = isCreditCardPayment({ pfc_detailed: t.pfc_detailed, user_category: t.user_category })

  return (
    <tr className="border-b border-line transition-colors hover:bg-surface-2">
      <td className="px-4 py-3 whitespace-nowrap text-sm text-muted">{t.date}</td>
      {/* Truncated rather than wrapped: a fixed column would otherwise give one long merchant a
          two-line row and leave the table's rhythm uneven. `title` keeps the full name reachable. */}
      <td className="truncate px-4 py-3 font-medium text-ink" title={label ?? undefined}>
        {label}
      </td>
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
        {/* ALWAYS rendered, merely hidden when unmarked. Conditionally mounting this line meant
            ticking the box added a second line to the cell, which grew the row and pushed every
            row beneath it down the page — the reader's place jumps on every tick (#50).
            `invisible` is visibility:hidden, so the space stays reserved and assistive tech still
            skips it. Where the row's height is already set by the taller category control, the
            reserved line costs nothing at all. */}
        {/* nowrap: the Amount column is 160px, and "your share -$12,345.67" would wrap to two lines
            at text-xs — reintroducing the very row growth the reserved line exists to prevent. */}
        <span
          className={`block truncate text-xs font-normal whitespace-nowrap text-faint ${marked > 0 ? '' : 'invisible'}`}
        >
          {/* An outflow's share is money out (shown negative); an inflow's untagged remainder is
              money in (shown positive) — matching the `display` convention above. */}
          {marked > 0 ? `your share ${money(t.amount < 0 ? share : -share)}` : '\u00A0'}
        </span>
      </td>
      {/* Its own column, under a "Reimbursable" header: the word used to be printed in every cell,
          which is the header's job. */}
      <td className="px-4 py-3 text-right">
        <ReimbursableCheckbox
          transactionId={t.id}
          amount={t.amount}
          reimbursableAmount={t.reimbursable_amount}
          note={t.reimbursable_note}
          label={label ?? 'transaction'}
          pfcDetailed={t.pfc_detailed}
          userCategory={t.user_category}
        />
      </td>
      {/* The editor owns its own trigger now. A menu wrapper made sense when it might hold several
          actions; with exactly one it was ceremony, and on a credit-card payment it opened onto an
          empty panel. Nothing renders here for those rows instead. */}
      <td className="px-4 py-3 text-right">
        {!isCC && (
          <ReimbursableEditor
            transactionId={t.id}
            amount={t.amount}
            reimbursableAmount={t.reimbursable_amount}
            note={t.reimbursable_note}
            label={label ?? 'transaction'}
            date={t.date}
          />
        )}
      </td>
    </tr>
  )
}
