import { createClient } from '@/lib/supabase/server'
import { PageHeader } from '@/components/ui/PageHeader'
import { ClaimList, type ClaimRow } from '@/components/ClaimList'
import { claimTotals, type Claim, type Split } from '@/lib/reimbursements'
import { money } from '@/lib/format'

export default async function ReimbursementsPage() {
  const supabase = await createClient()

  const { data: claimRows } = await supabase
    .from('reimbursement_claims')
    .select('id, name, written_off_on')
    .order('created_at', { ascending: false })
  const { data: splitRows } = await supabase
    .from('reimbursement_splits')
    .select('transaction_id, claim_id, owed_by, amount')
  const { data: txns } = await supabase.from('transactions').select('id, amount, date')

  const amountById: Record<string, number> = {}
  const dateById: Record<string, string> = {}
  for (const t of txns ?? []) {
    amountById[t.id as string] = Number(t.amount)
    dateById[t.id as string] = t.date as string
  }

  const splits = ((splitRows ?? []) as unknown as Split[]).map((s) => ({
    ...s,
    amount: Number(s.amount),
  }))
  const today = new Date()

  const claims: ClaimRow[] = ((claimRows ?? []) as Claim[]).map((c) => {
    const mine = splits.filter((s) => s.claim_id === c.id)
    const totals = claimTotals(c, mine, amountById)
    // How long the money has been out, to tell a slow payer from a new one.
    const expenseDates = mine
      .filter((s) => (amountById[s.transaction_id] ?? 0) > 0)
      .map((s) => dateById[s.transaction_id])
      .filter(Boolean)
      .sort()
    const oldest = expenseDates[0]
    const oldestUnpaidDays =
      oldest && totals.outstanding > 0
        ? Math.floor((today.getTime() - new Date(oldest).getTime()) / 86_400_000)
        : null
    return { ...c, totals, oldestUnpaidDays }
  })

  // Open claims first, biggest outstanding at the top; settled and written-off sink to the bottom.
  claims.sort((a, b) => {
    const aDone = a.totals.writtenOff || a.totals.settled
    const bDone = b.totals.writtenOff || b.totals.settled
    if (aDone !== bDone) return aDone ? 1 : -1
    return b.totals.outstanding - a.totals.outstanding
  })

  const outstanding = claims.reduce(
    (s, c) => s + (c.totals.writtenOff ? 0 : Math.max(0, c.totals.outstanding)),
    0
  )

  return (
    <div className="space-y-6">
      <PageHeader
        title="Reimbursements"
        subtitle={
          outstanding > 0
            ? `You're owed ${money(outstanding)}.`
            : 'Money other people owe you, and what has come back.'
        }
      />
      <ClaimList claims={claims} />
    </div>
  )
}
