import { money } from '@/lib/format'
import { isLiability } from '@/lib/dashboard'
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
  const owed = isLiability(account.type)
  const balance = account.current_balance ?? 0
  const currency = account.iso_currency_code ?? 'USD'

  return (
    <Card className="p-4">
      <div className="truncate text-sm text-muted">
        {account.name} · <span className="capitalize">{account.subtype ?? account.type}</span>
      </div>
      <div
        className={`mt-1 text-xl font-semibold tabular-nums ${owed ? 'text-coral' : 'text-ink'}`}
      >
        {owed ? `−${money(balance, currency)}` : money(balance, currency)}
      </div>
      {owed && <div className="text-xs text-faint">Owed</div>}
    </Card>
  )
}
