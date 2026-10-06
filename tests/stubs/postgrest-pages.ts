// A stand-in for one PostgREST table read that behaves like the real server where paging is
// concerned, so a test fails if a page stops reading through lib/read-all.ts (#69):
// - rows come back sorted by the .order() columns asked for, and only those: rows tied on them
//   come back in an arbitrary order (here, ids descending), as Postgres may return them;
// - each response is capped at `serverCap` rows, whatever was asked for (PostgREST's max-rows);
// - `.limit()` and the keyset `.or()` that readAllRows sends are honoured;
// - a read with no limit still gets only the first `serverCap` rows, as an unbounded read does.
//
// Only the filters the paged reads use are modelled; anything else is accepted and ignored, which
// is why the fixtures in page tests carry only rows the page's own filters would keep.

type Row = { id: string; date: string } & Record<string, unknown>
type Result = { data: Row[] | null; error: { message: string } | null }

export type PagedTable = {
  // Every request's [after-cursor, limit], so a test can see how the read was paged.
  requests: { after: string | null; limit: number | null }[]
  // A chainable query over the rows. Call it once per `supabase.from(table)`.
  query: () => Record<string, unknown>
}

const KEYSET = /^date\.gt\.([^,]+),and\(date\.eq\.([^,]+),id\.gt\.([^)]+)\)$/

export function pagedTable(
  rows: Row[],
  opts: { serverCap?: number; failOnRequest?: number; emptyBodyOnRequest?: number } = {}
): PagedTable {
  const cap = opts.serverCap ?? 1000
  const requests: PagedTable['requests'] = []

  const query = () => {
    let after: { date: string; id: string } | null = null
    let limit: number | null = null
    const orders: string[] = []
    const chain: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'gte', 'lt', 'lte', 'not']) chain[m] = () => chain
    chain.order = (col: string) => {
      orders.push(col)
      return chain
    }
    chain.limit = (n: number) => {
      limit = n
      return chain
    }
    chain.or = (filter: string) => {
      const m = filter.match(KEYSET)
      if (!m || m[1] !== m[2]) throw new Error(`unexpected .or() filter: ${filter}`)
      after = { date: m[1], id: m[3] }
      return chain
    }
    chain.then = (resolve: (r: Result) => unknown) => {
      requests.push({ after: after ? `${after.date}/${after.id}` : null, limit })
      const n = requests.length
      if (opts.failOnRequest === n) {
        return Promise.resolve({ data: null, error: { message: 'boom' } }).then(resolve)
      }
      if (opts.emptyBodyOnRequest === n) {
        return Promise.resolve({ data: null, error: null }).then(resolve)
      }
      const sorted = [...rows].sort((x, y) => {
        for (const col of orders) {
          const [p, q] = [String(x[col]), String(y[col])]
          if (p !== q) return p < q ? -1 : 1
        }
        return x.id < y.id ? 1 : -1
      })
      const a = after
      const rest = a
        ? sorted.filter((r) => r.date > a.date || (r.date === a.date && r.id > a.id))
        : sorted
      return Promise.resolve({ data: rest.slice(0, Math.min(limit ?? cap, cap)), error: null }).then(
        resolve
      )
    }
    return chain
  }

  return { requests, query }
}

// `n` transactions dated from `start`, a few per day, so dates tie and the id tiebreak matters.
export function txnRows(n: number, start = '2026-05-01', extra: Record<string, unknown> = {}): Row[] {
  const base = Date.parse(`${start}T00:00:00Z`)
  return Array.from({ length: n }, (_, i) => ({
    id: `t${String(i).padStart(5, '0')}`,
    date: new Date(base + Math.floor(i / 6) * 86_400_000).toISOString().slice(0, 10),
    ...extra,
  }))
}
