import { money } from '@/lib/format'
import { CategoryPicker } from './CategoryPicker'

type Txn = {
  id: string
  date: string
  name: string | null
  merchant_name: string | null
  amount: number
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
  return (
    <tr className="border-b border-line transition-colors hover:bg-surface-2">
      <td className="px-4 py-3 whitespace-nowrap text-sm text-muted">{t.date}</td>
      <td className="px-4 py-3 font-medium text-ink">{t.merchant_name ?? t.name}</td>
      <td className="px-4 py-3">
        <CategoryPicker transactionId={t.id} value={categoryName} options={categoryOptions} />
      </td>
      <td
        className={`px-4 py-3 text-right font-medium tabular-nums ${display < 0 ? 'text-ink' : 'text-emerald'}`}
      >
        {money(display)}
      </td>
    </tr>
  )
}
