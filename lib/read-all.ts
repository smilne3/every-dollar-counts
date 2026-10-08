// Rows asked for per request. PostgREST also caps each response at the project's max-rows (a
// Supabase setting, 1,000 today, not recorded in this repo). The read below never assumes the two
// match: it ends on an empty page, never on a short one, so a lower cap costs requests, not rows.
export const PAGE_SIZE = 1000

type Failure = { data: null; error: { message: string; code?: string } }
type Success<T> = { data: T[]; error: null }

// The part of a Supabase query this needs. Structural, so callers pass the real builder without
// threading Supabase's generics through.
export interface PageableQuery<T> {
  order(column: string, options?: { ascending?: boolean }): PageableQuery<T>
  or(filters: string): PageableQuery<T>
  limit(count: number): PromiseLike<{ data: T[] | null; error: { message: string } | null }>
}

// Reads every row a `transactions`-shaped query matches (it needs `date` and `id` columns). Any
// read whose size grows with the household's history uses this; `check-invariants` holds every
// `transactions` read to it or to an explicit bound (#69).
//
// `build` returns a NEW, unbounded query each call: no .range(), .limit() or head-only select of
// its own, because this owns paging. A new one because Supabase's builder mutates itself in place
// and `.order()` appends, so a reused builder would pile up one more `date, id` ordering per page.
//
// Paging is by key, not by offset: each request asks for the rows after the last (date, id) read.
// Offsets would shift when a sync inserts or removes a row mid-read, and a real transaction could
// then be skipped or read twice. By key, a row written behind the cursor mid-read is simply not
// seen, as if the read had started a moment earlier; nothing already there is skipped.
//
// The result says either "error" or "every row", never part of the rows (#46):
// - a failed page fails the whole read;
// - a response with neither data nor error (postgrest-js's reading of an empty body) is a failure,
//   not an empty page, since an empty page is what ends the read;
// - a page that does not move past the last row read is a failure, rather than a loop.
export async function readAllRows<T extends { id: string; date: string }>(
  build: () => PageableQuery<T>
): Promise<Success<T> | Failure> {
  const all: T[] = []
  let last: T | null = null
  for (;;) {
    let query = build().order('date').order('id')
    if (last) query = query.or(`date.gt.${last.date},and(date.eq.${last.date},id.gt.${last.id})`)
    const { data, error } = await query.limit(PAGE_SIZE)
    if (error) return { data: null, error }
    if (!data) return { data: null, error: { message: 'read returned no data and no error' } }
    if (data.length === 0) return { data: all, error: null }
    const end = data[data.length - 1]
    if (last && (end.date < last.date || (end.date === last.date && end.id <= last.id))) {
      return { data: null, error: { message: 'paged read did not advance past the last row' } }
    }
    all.push(...data)
    last = end
  }
}

// The part of a Supabase query an id-keyed read needs.
export interface IdPageableQuery<T> {
  order(column: string, options?: { ascending?: boolean }): IdPageableQuery<T>
  gt(column: string, value: string): IdPageableQuery<T>
  limit(count: number): PromiseLike<{ data: T[] | null; error: { message: string; code?: string } | null }>
}

// readAllRows for a table with no `date` column (category_rules, #28): pages on `id` alone. The
// same contract, for the same reasons: `build` returns a new, unbounded query each call; paging is
// by key; the read ends only on an empty page; a failed page, an empty body, or a page that does
// not move past the last id fails the whole read.
//
// Ids are uuids. Postgres orders uuid by its bytes, which is the order of their lowercase hex text,
// so the string comparison below agrees with the server's `order by id`.
export async function readAllById<T extends { id: string }>(
  build: () => IdPageableQuery<T>
): Promise<Success<T> | Failure> {
  const all: T[] = []
  let lastId: string | null = null
  for (;;) {
    let query = build().order('id')
    if (lastId !== null) query = query.gt('id', lastId)
    const { data, error } = await query.limit(PAGE_SIZE)
    if (error) return { data: null, error }
    if (!data) return { data: null, error: { message: 'read returned no data and no error' } }
    if (data.length === 0) return { data: all, error: null }
    const end = data[data.length - 1].id
    if (lastId !== null && end <= lastId) {
      return { data: null, error: { message: 'paged read did not advance past the last row' } }
    }
    all.push(...data)
    lastId = end
  }
}
