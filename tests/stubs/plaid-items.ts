// A strict stand-in for the service-role read of plaid_items in lib/plaid-items.ts, for the page
// tests that check the "isn't syncing" banner (#135). That client bypasses RLS, so the read's own
// filters are all that keep another household's banks off a page. So here, as in Postgres:
// - the stored rows carry household_id and plaid_env, and every .eq() narrows them;
// - .select() returns only the columns it names, and .order() sorts by the one it names;
// - a failed read, or one with no body, comes back exactly as given.
// A page that read the wrong household, or no household, then shows the wrong banks and its test
// fails, where a stub that answered every read alike would pass it (#99).

type Reply = { data: unknown; error: { message: string; code?: string } | null }
type Row = Record<string, unknown>

// The household the page tests sign in as, in the environment their lib/plaid stand-in names.
export const HOUSEHOLD = 'hh-1'

// One bank as stored, token included: the read must leave it behind.
export function storedItem(over: Row = {}): Row {
  return {
    id: 'item-1',
    household_id: HOUSEHOLD,
    plaid_env: 'sandbox',
    institution_name: 'Capital One',
    status: 'ok',
    status_detail: null,
    products: ['transactions'],
    created_at: '2026-07-14T18:05:30Z',
    access_token_encrypted: 'cipher',
    ...over,
  }
}

// Banks no page of HOUSEHOLD in sandbox may show: another household's, and one of its own from the
// other Plaid environment. Both are broken, so a page that let either through would show a banner.
export const FOREIGN_ITEMS: Row[] = [
  storedItem({ id: 'item-hh-2', household_id: 'hh-2', institution_name: 'Chase', status: 'needs_reconnect' }),
  storedItem({ id: 'item-production', plaid_env: 'production', institution_name: 'Wells Fargo', status: 'needs_reconnect' }),
]

// The signed-in client's side. plaid_items holds the encrypted access token, so RLS is on with no
// policy for a signed-in person (db/migrations/006_rls_policies.sql): through createClient() every
// read of it answers no rows and no error. Nothing fails, and the bank is missing, which is how the
// savings average came to wait for "A bank" whatever the bank was called (#169). The per-user
// stand-ins call this on every from(), so such a read fails its test, by name, instead.
export function refuseSignedInPlaidItems(table: string): void {
  if (table === 'plaid_items') {
    throw new Error(
      'plaid_items read through the signed-in client, which RLS answers with no rows: read it through lib/plaid-items.ts (#169)'
    )
  }
}

// One `supabaseAdmin.from('plaid_items')` query over `reply`'s rows. Call it once per from().
// `held`, when given, keeps the read from answering until it settles, so a page test can tell a
// read made beside another from one made after it (#156).
export function plaidItemsQuery(reply: Reply, held?: Promise<unknown>): Record<string, unknown> {
  const filters: [string, unknown][] = []
  let columns: string[] | null = null
  let orderBy: string | null = null
  const chain: Record<string, unknown> = {}
  chain.select = (cols: string) => {
    columns = cols.split(',').map((c) => c.trim())
    return chain
  }
  chain.eq = (col: string, value: unknown) => {
    filters.push([col, value])
    return chain
  }
  chain.order = (col: string) => {
    orderBy = col
    return chain
  }
  const answer = (resolve: (r: unknown) => unknown, reject?: (e: unknown) => unknown) => {
    if (reply.error || !Array.isArray(reply.data)) return Promise.resolve(reply).then(resolve, reject)
    const cols = columns
    if (!cols) return Promise.reject(new Error('plaid_items stand-in: read without a select()')).then(resolve, reject)
    const by = orderBy
    const rows = (reply.data as Row[])
      .filter((r) => filters.every(([c, v]) => r[c] === v))
      .sort((x, y) => (by === null ? 0 : String(x[by]) < String(y[by]) ? -1 : String(x[by]) > String(y[by]) ? 1 : 0))
      .map((r) => Object.fromEntries(cols.filter((c) => c in r).map((c) => [c, r[c]])))
    return Promise.resolve({ data: rows, error: null }).then(resolve, reject)
  }
  chain.then = (resolve: (r: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    held ? held.then(() => answer(resolve, reject)) : answer(resolve, reject)
  return chain
}
