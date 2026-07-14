import { money } from '@/lib/format'
import { Card } from './ui/Card'

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
    <Card className="p-4">
      <div className="truncate text-sm text-muted">
        {account.name} · <span className="capitalize">{account.subtype ?? account.type}</span>
      </div>
      <div className="mt-1 text-xl font-semibold tabular-nums text-ink">
        {money(account.current_balance, account.iso_currency_code ?? 'USD')}
      </div>
    </Card>
  )
}
