import 'server-only'
import { createClient } from '@/lib/supabase/server'

// The month ('YYYY-MM') from which the household's history is complete, or null if it has no
// transactions. The average-savings figure (#126) counts only months after it.
//
// It is the LAST account's first month, not the household's first transaction. Each bank supplies a
// different amount of history when it is linked: on 2026-10-06 Amex went back to 2025-10-18 and
// Capital One only to 2026-04-27. Until Capital One's history begins, checking (where income lands)
// is missing entirely, so a month like April 2026 reads as $2,820 in against a usual $17,000-plus.
// That month is itself partial, so averaging starts the month after.
//
// Accounts with no transactions (a loan, an investment account) have no history to wait for. One
// small read per account; a household has a handful. One function so the dashboard tile and the
// saved breakdown cannot disagree about where history begins. A failed read throws: answering null
// would hide the average as if there were no history (#46).
export async function historyStartMonth(): Promise<string | null> {
  const supabase = await createClient()
  const { data: accounts, error } = await supabase.from('accounts').select('account_id')
  if (error) throw new Error(`could not read accounts: ${error.message}`)

  const firsts = await Promise.all(
    (accounts ?? []).map(async ({ account_id }) => {
      const { data, error: txnError } = await supabase
        .from('transactions')
        .select('date')
        .eq('account_id', account_id)
        .eq('removed', false)
        .order('date', { ascending: true })
        .limit(1)
      if (txnError) throw new Error(`could not read the first transaction: ${txnError.message}`)
      return (data?.[0]?.date as string | undefined) ?? null
    })
  )
  const starts = firsts.filter((d): d is string => d !== null).sort()
  return starts.length ? starts[starts.length - 1].slice(0, 7) : null
}
