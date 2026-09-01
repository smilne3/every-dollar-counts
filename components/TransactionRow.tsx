import { money } from '@/lib/format'
import { isCreditCardPayment } from '@/lib/categories'
import { CategoryPicker } from './CategoryPicker'
import { ReimbursableCheckbox } from './ReimbursableCheckbox'
import { RowMenu } from './RowMenu'
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
  // editor in the row menu must not be offered on one either — reuse the one predicate rather than
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
        {marked > 0 && (
          <span className="block text-xs font-normal text-faint">
            {/* An outflow's share is money out (shown negative); an inflow's untagged remainder is
                money in (shown positive) — matching the `display` convention above. */}
            your share {money(t.amount < 0 ? share : -share)}
          </span>
        )}
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
      <td className="px-4 py-3 text-right">
        <RowMenu label={label ?? 'transaction'}>
          {!isCC && (
            <ReimbursableEditor
              transactionId={t.id}
              amount={t.amount}
              reimbursableAmount={t.reimbursable_amount}
              note={t.reimbursable_note}
            />
          )}
        </RowMenu>
      </td>
    </tr>
  )
}
