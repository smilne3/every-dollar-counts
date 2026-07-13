import { money } from '@/lib/format'

type Account = {
  id: string
  name: string | null
  type: string | null
  subtype: string | null
  current_balance: number | null
  iso_currency_code: string | null
}

export function AccountCard({ account }: { account: Account }) {
  return (
    <div className="rounded border p-4">
      <div className="text-sm text-gray-500">
        {account.name} · {account.subtype ?? account.type}
      </div>
      <div className="text-xl font-semibold">
        {money(account.current_balance, account.iso_currency_code ?? 'USD')}
      </div>
    </div>
  )
}
