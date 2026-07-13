import { createClient } from '@/lib/supabase/server'
import { AccountCard } from '@/components/AccountCard'
import { LinkButton } from '@/components/LinkButton'
import { RefreshButton } from '@/components/RefreshButton'
import { money } from '@/lib/format'

export default async function DashboardPage() {
  const supabase = await createClient()
  const { data: accounts } = await supabase.from('accounts').select('*').order('name')
  const list = accounts ?? []

  if (list.length === 0) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <p className="text-gray-600">Connect a bank to see your accounts and balances here.</p>
        <LinkButton />
      </div>
    )
  }

  const assets = list
    .filter((a) => ['depository', 'investment', 'other'].includes(a.type))
    .reduce((s, a) => s + (a.current_balance ?? 0), 0)
  const liabilities = list
    .filter((a) => ['credit', 'loan'].includes(a.type))
    .reduce((s, a) => s + (a.current_balance ?? 0), 0)
  const total = assets - liabilities
  const currency = list[0]?.iso_currency_code ?? 'USD'

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <div className="flex items-center gap-2">
          <RefreshButton />
          <LinkButton />
        </div>
      </div>

      <div className="rounded border p-4">
        <div className="text-sm text-gray-500">Total net</div>
        <div className="text-3xl font-semibold">{money(total, currency)}</div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {list.map((a) => (
          <AccountCard key={a.id} account={a} />
        ))}
      </div>
    </div>
  )
}
