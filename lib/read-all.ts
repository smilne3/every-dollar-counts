// PostgREST returns at most this many rows per request, with a 200 and no error, so a read that
// matches more gets the first 1,000 and renders them as though they were all of it (#69).
export const PAGE_SIZE = 1000

type Page<T> = { data: T[] | null; error: { message: string } | null }

// The part of a Supabase query this needs. Structural, so callers pass the real builder without
// threading Supabase's generics through.
interface PageableQuery<T> {
  order(column: string, options?: { ascending?: boolean }): PageableQuery<T>
  range(from: number, to: number): PromiseLike<Page<T>>
}

// Reads every row a query matches, a page at a time. Use it for any read whose size grows with the
// household's history; `check-invariants` holds every `transactions` read to it or to an explicit
// bound.
//
// `build` must return a NEW query each call: Supabase's builder mutates itself, so re-using one
// object would stack a second `range` onto the first.
//
// Contract, matching a plain Supabase read so `if (error) throw` call sites keep working (#46):
// - any failed page fails the whole read, with `data: null`. Never part of the rows, which would
//   be the silent truncation this exists to stop;
// - pages are ordered by `date` then `id`. Paging needs a total order, and `date` ties constantly
//   (#50);
// - rows are de-duplicated by `id`. A sync inserting rows mid-read shifts later pages, and a row
//   can then arrive twice. A row inserted behind the cursor can still be missed, which is the same
//   as reading a moment earlier.
export async function readAllRows<T extends { id: string }>(
  build: () => PageableQuery<T>
): Promise<Page<T>> {
  const seen = new Set<string>()
  const all: T[] = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await build()
      .order('date')
      .order('id')
      .range(from, from + PAGE_SIZE - 1)
    if (error) return { data: null, error }
    const page = data ?? []
    for (const row of page) {
      if (seen.has(row.id)) continue
      seen.add(row.id)
      all.push(row)
    }
    if (page.length < PAGE_SIZE) return { data: all, error: null }
  }
}
