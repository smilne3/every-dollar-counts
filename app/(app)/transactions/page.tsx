import { createClient } from '@/lib/supabase/server'
import { TransactionRow } from '@/components/TransactionRow'
import { effectiveCategory } from '@/lib/effective-category'
import { pfcToName, type Category } from '@/lib/categories'

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>
}) {
  const { q } = await searchParams
  const safe = (q ?? '').replace(/[,()%*]/g, ' ').trim()

  const supabase = await createClient()
  const { data: cats } = await supabase
    .from('categories')
    .select('id, name, pfc_primary, sort_order')
    .order('sort_order')
  const categories = (cats ?? []) as Category[]
  const pfcMap = pfcToName(categories)
  const categoryOptions = categories.map((c) => c.name)

  let query = supabase
    .from('transactions')
    .select('id, name, merchant_name, amount, date, user_category, pfc_primary')
    .eq('removed', false)
    .order('date', { ascending: false })
    .limit(200)
  if (safe) query = query.or(`name.ilike.%${safe}%,merchant_name.ilike.%${safe}%`)
  const { data: txns } = await query
  const list = txns ?? []

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Transactions</h1>

      <form className="flex gap-2">
        <input
          name="q"
          defaultValue={q ?? ''}
          placeholder="Search merchant…"
          className="rounded border p-2 text-sm"
        />
        <button className="rounded border px-3 text-sm hover:bg-gray-50">Search</button>
      </form>

      {list.length === 0 ? (
        <p className="text-gray-600">No transactions yet. Connect a bank on the Dashboard.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-gray-500">
                <th className="py-2 pr-4">Date</th>
                <th className="py-2 pr-4">Merchant</th>
                <th className="py-2 pr-4">Category</th>
                <th className="py-2 pr-4 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {list.map((t) => (
                <TransactionRow
                  key={t.id}
                  t={t}
                  categoryName={effectiveCategory(t, pfcMap)}
                  categoryOptions={categoryOptions}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
