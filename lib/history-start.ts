import 'server-only'
import { createClient } from '@/lib/supabase/server'
import { isCashFlowAccount } from '@/lib/account-types'

// Each bank's first transaction date ('YYYY-MM-DD'), by its plaid_items id as accounts.plaid_item_id
// holds it, or null while none of its accounts has one: its first sync has not landed. Only a bank
// with a cash-flow account is in it, so a household with none has an empty map.
//
// savedAverage (lib/dashboard.ts) decides from it where the household's history is complete enough
// to average (#126). It names a bank from the household's bank list, and leaves out one that never
// syncs transactions (#170): this reads with the signed-in client, which RLS gives no plaid_items
// rows at all (#169), so it can see neither a bank's name nor what it was linked for.
export type HistoryStarts = ReadonlyMap<string, string | null>

// Per bank, not per account: a bank's history starts at its earliest account. A card opened last
// month at a bank already linked is new activity, not missing history, and must not move the start
// (it would hide the average for months). A whole bank linked later, with only recent history, does
// move it, because before then that bank's spending is genuinely missing.
//
// Loans and investments carry no transactions (migration 020) and are not read. One small read per
// account; a household has a handful. A failed or empty read throws, so it can never pass for "no
// history yet" (#46).
export async function historyStart(): Promise<HistoryStarts> {
  const supabase = await createClient()

  const { data: accounts, error } = await supabase.from('accounts').select('account_id, type, plaid_item_id')
  if (error) throw new Error(`could not read accounts: ${error.message}`)
  if (!accounts) throw new Error('could not read accounts: no data and no error')
  const cashFlow = accounts.filter((a) => isCashFlowAccount(a.type as string | null))

  const firsts = await Promise.all(
    cashFlow.map(async (a) => {
      const { data, error: txnError } = await supabase
        .from('transactions')
        .select('date')
        .eq('account_id', a.account_id)
        .eq('removed', false)
        .order('date', { ascending: true })
        .limit(1)
      if (txnError) throw new Error(`could not read the first transaction: ${txnError.message}`)
      if (!data) throw new Error('could not read the first transaction: no data and no error')
      return { bank: a.plaid_item_id as string, first: (data[0]?.date as string | undefined) ?? null }
    })
  )

  // Each bank's start is its earliest account's first transaction; null while none has any.
  const byBank = new Map<string, string | null>()
  for (const { bank, first } of firsts) {
    const seen = byBank.get(bank) ?? null
    byBank.set(bank, first === null ? seen : seen === null || first < seen ? first : seen)
  }
  return byBank
}
