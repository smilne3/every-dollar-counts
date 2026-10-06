import 'server-only'
import { createClient } from '@/lib/supabase/server'
import { isCashFlowAccount } from '@/lib/account-types'

// Where the household's history is complete enough to average (#126):
// - `ready`: from `month` ('YYYY-MM') every bank's history has begun. That month is itself partial,
//   so the average-savings figure counts only the months after it;
// - `pending`: `bank` is linked but its first sync has not landed. Averaging without it would count
//   months missing a whole bank, so there is no figure until it arrives;
// - `none`: no cash-flow accounts with transactions at all.
export type HistoryStart =
  | { kind: 'ready'; month: string }
  | { kind: 'pending'; bank: string }
  | { kind: 'none' }

// Each bank supplies a different amount of history when it is linked: on 2026-10-06 Amex went back
// to 2025-10-18 and Capital One only to 2026-04-27. Until Capital One's history begins, checking
// (where income lands) is missing entirely, so April 2026 reads as $2,820 in against a usual
// $17,000-plus. So the start is the LAST bank's first month.
//
// Per bank, not per account: a bank's history starts at its earliest account. A card opened last
// month at a bank already linked is new activity, not missing history, and must not move the start
// (it would hide the average for months). A whole bank linked later, with only recent history, does
// move it, because before then that bank's spending is genuinely missing.
//
// Loans and investments carry no transactions (migration 020) and are not waited for. One small
// read per account; a household has a handful. A failed or empty read throws, so it can never pass
// for "no history yet" (#46).
export async function historyStart(): Promise<HistoryStart> {
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
  if (!byBank.size) return { kind: 'none' }

  const waiting = [...byBank].find(([, start]) => start === null)
  if (waiting) {
    const { data: item, error: itemError } = await supabase
      .from('plaid_items')
      .select('institution_name')
      .eq('id', waiting[0])
      .limit(1)
    if (itemError) throw new Error(`could not read the bank: ${itemError.message}`)
    if (!item) throw new Error('could not read the bank: no data and no error')
    return { kind: 'pending', bank: (item[0]?.institution_name as string | undefined) ?? 'A bank' }
  }

  const latest = [...byBank.values()].sort().pop() as string
  return { kind: 'ready', month: latest.slice(0, 7) }
}
