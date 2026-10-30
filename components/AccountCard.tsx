import { moneyFigure } from '@/lib/format'
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
  const balance = moneyFigure(account.current_balance ?? 0, account.iso_currency_code ?? 'USD')
  // A debt reads as a negative, in coral, by the figure shown: one under 50 cents shows "$0", and
  // "−$0" in coral would be a debt of nothing (#215).
  const negative = owed && balance.value !== 0

  return (
    <Card className="p-4">
      <div className="truncate text-sm text-muted">
        {account.name} · <span className="capitalize">{account.subtype ?? account.type}</span>
      </div>
      <div
        className={`mt-1 text-xl font-semibold tabular-nums ${negative ? 'text-coral' : 'text-ink'}`}
      >
        {negative ? `−${balance.text}` : balance.text}
      </div>
      {owed && <div className="text-xs text-faint">Owed</div>}
    </Card>
  )
}
