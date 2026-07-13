import { money } from '@/lib/format'
import { effectiveCategory } from '@/lib/effective-category'
import { CategoryPicker } from './CategoryPicker'

type Txn = {
  id: string
  date: string
  name: string | null
  merchant_name: string | null
  amount: number
  user_category: string | null
  pfc_primary: string | null
}

export function TransactionRow({ t }: { t: Txn }) {
  const eff = effectiveCategory(t)
  // Plaid: amount > 0 means money OUT. Show spending as negative (red).
  const display = -t.amount
  return (
    <tr className="border-b">
      <td className="py-2 pr-4 whitespace-nowrap text-sm text-gray-500">{t.date}</td>
      <td className="py-2 pr-4">{t.merchant_name ?? t.name}</td>
      <td className="py-2 pr-4">
        <CategoryPicker transactionId={t.id} value={eff} />
      </td>
      <td
        className={`py-2 pr-4 text-right tabular-nums ${display < 0 ? 'text-red-600' : 'text-green-700'}`}
      >
        {money(display)}
      </td>
    </tr>
  )
}
