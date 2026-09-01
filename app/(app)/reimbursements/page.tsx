import { createClient } from '@/lib/supabase/server'
import { PageHeader } from '@/components/ui/PageHeader'
import { Card } from '@/components/ui/Card'
import { money } from '@/lib/format'
import { unreimbursedExpenses, owedToYou, type DatedReimbursableTxn } from '@/lib/reimbursements'

type Row = DatedReimbursableTxn & {
  name: string
  merchant_name: string | null
  reimbursable_note: string | null
}

// 'YYYY-MM' -> 'August 2026'. Built from the key's own numbers (not by re-parsing a 'YYYY-MM-DD'
// string with `new Date(...)`, which reads as local time and can roll into the wrong month) so a
// household west of UTC never sees a July expense filed under August.
function monthLabel(key: string): string {
  const [year, month] = key.split('-').map(Number)
  return new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.UTC(year, month - 1, 1))
  )
}

export default async function ReimbursementsPage() {
  const supabase = await createClient()

  // Every marked row, both directions. No window: an expense from last year is still owed, and the
  // FIFO allocation needs the deposits that settled the older ones to be correct about the newer.
  const { data, error } = await supabase
    .from('transactions')
    .select('id, amount, date, name, merchant_name, reimbursable_amount, reimbursable_note')
    .not('reimbursable_amount', 'is', null)
    .eq('removed', false)
    .order('date', { ascending: false })

  // #46's lesson: a failed read must not render as "nothing outstanding".
  if (error) throw new Error(`could not read reimbursable transactions: ${error.message}`)

  const rows = (data ?? []) as Row[]
  const byId = new Map(rows.map((r) => [r.id, r]))

  // Already oldest-first, which is the order an expense report wants — do not re-sort it.
  const outstanding = unreimbursedExpenses(rows)
  const owed = owedToYou(rows)

  // Marked expenses the deposits HAVE covered: every marked outflow whose id did not come back from
  // the allocation above. Derived from that same call's output — never re-run with different inputs
  // — so the two lists can't disagree about the same transaction.
  const outstandingIds = new Set(outstanding.map((r) => r.id))
  const covered = rows.filter(
    (t) => t.amount > 0 && Number(t.reimbursable_amount ?? 0) > 0 && !outstandingIds.has(t.id)
  )
  const coveredByMonth = new Map<string, Row[]>()
  for (const t of covered) {
    const key = t.date.slice(0, 7)
    const list = coveredByMonth.get(key)
    if (list) list.push(t)
    else coveredByMonth.set(key, [t])
  }
  // Most recent month first. `rows` (and therefore each month's list) is already date-descending
  // from the query, so only the group order needs sorting here.
  const coveredMonths = [...coveredByMonth.keys()].sort((a, b) => b.localeCompare(a))

  return (
    <div className="space-y-6">
      <PageHeader
        title="Reimbursable"
        subtitle={
          owed > 0
            ? `You're owed ${money(owed)}. These are the expenses to put on your next report.`
            : 'Nothing outstanding. Tick a transaction as reimbursable and it will appear here.'
        }
      />

      {outstanding.length === 0 ? (
        <Card className="p-8 text-center">
          <p className="text-sm text-muted">
            Nothing outstanding. Mark a transaction reimbursable from the Transactions page to start
            tracking expenses to put on your next report.
          </p>
        </Card>
      ) : (
        <Card className="p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left">
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-faint">
                  Date
                </th>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-faint">
                  Merchant
                </th>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-faint">
                  Note
                </th>
                <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wide text-faint">
                  Outstanding
                </th>
              </tr>
            </thead>
            <tbody>
              {outstanding.map((r) => {
                const t = byId.get(r.id)
                return (
                  <tr key={r.id} className="border-b border-line last:border-b-0">
                    <td className="px-4 py-3 whitespace-nowrap text-sm text-muted">{r.date}</td>
                    <td className="truncate px-4 py-3 font-medium text-ink">
                      {t?.merchant_name ?? t?.name ?? 'Transaction'}
                    </td>
                    <td className="truncate px-4 py-3 text-sm text-muted">{t?.reimbursable_note}</td>
                    <td className="px-4 py-3 text-right font-medium tabular-nums text-ink">
                      {money(r.remaining)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </Card>
      )}

      {coveredMonths.length > 0 && (
        <div className="space-y-4">
          <h2 className="text-sm font-semibold text-ink">Already reimbursed</h2>
          {coveredMonths.map((key) => (
            <Card key={key} className="p-0">
              <div className="border-b border-line px-4 py-3">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-faint">
                  {monthLabel(key)}
                </h3>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left">
                    <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-faint">
                      Date
                    </th>
                    <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-faint">
                      Merchant
                    </th>
                    <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-faint">
                      Note
                    </th>
                    {/* The FULL marked amount — not the outstanding remainder the visually similar
                        column in the table above shows. Labelled distinctly so the two quantities
                        are never mistaken for each other. */}
                    <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wide text-faint">
                      Reimbursed
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {coveredByMonth.get(key)!.map((t) => (
                    <tr key={t.id} className="border-b border-line last:border-b-0">
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-muted">{t.date}</td>
                      <td className="truncate px-4 py-3 font-medium text-ink">
                        {t.merchant_name ?? t.name ?? 'Transaction'}
                      </td>
                      <td className="truncate px-4 py-3 text-sm text-muted">{t.reimbursable_note}</td>
                      <td className="px-4 py-3 text-right font-medium tabular-nums text-ink">
                        {money(Number(t.reimbursable_amount))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
