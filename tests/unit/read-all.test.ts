import { describe, it, expect } from 'vitest'
import { readAllRows, type PageableQuery } from '@/lib/read-all'
import { pagedTable, txnRows } from '../stubs/postgrest-pages'

// #69: PostgREST returns at most its max-rows per request (1,000 here), with a 200 and no error,
// so a read that matches more renders the first page as though it were all of it.

type Row = ReturnType<typeof txnRows>[number]
// The stub implements only what a paged read calls; the cast stands in for Supabase's builder type.
const read = (t: ReturnType<typeof pagedTable>) =>
  readAllRows(() => t.query() as unknown as PageableQuery<Row>)

describe('readAllRows', () => {
  it('reads past the cap, continuing after the last row each time', async () => {
    const t = pagedTable(txnRows(2366))
    const { data, error } = await read(t)
    expect(error).toBeNull()
    expect(data).toHaveLength(2366)
    // Three full-or-partial pages, then the empty page that proves the end.
    expect(t.requests.map((r) => r.after)).toEqual([
      null,
      `${txnRows(2366)[999].date}/t00999`,
      `${txnRows(2366)[1999].date}/t01999`,
      `${txnRows(2366)[2365].date}/t02365`,
    ])
  })

  // The server's max-rows is a Supabase setting, not in this repo. If it were ever below the page
  // size, a "stop on a short page" rule would end the read after the first page and call it done.
  it('does not depend on the server cap matching the page size', async () => {
    const t = pagedTable(txnRows(1366), { serverCap: 500 })
    const { data, error } = await read(t)
    expect(error).toBeNull()
    expect(data).toHaveLength(1366)
  })

  it('stops cleanly when the total is an exact multiple of the cap', async () => {
    const t = pagedTable(txnRows(1000))
    const { data } = await read(t)
    expect(data).toHaveLength(1000)
    expect(t.requests).toHaveLength(2)
  })

  it('reads a small result, confirming the end with one empty page', async () => {
    const t = pagedTable(txnRows(12))
    const { data } = await read(t)
    expect(data).toHaveLength(12)
    expect(t.requests).toHaveLength(2)
  })

  it('returns rows in date-then-id order', async () => {
    const t = pagedTable(txnRows(1500).reverse())
    const { data } = await read(t)
    expect(data!.map((r) => r.id)).toEqual(txnRows(1500).map((r) => r.id))
  })

  // #46: a failed read must never render as a plausible number. Returning page 1 when page 2
  // failed is exactly the silent truncation this exists to stop.
  it('fails the whole read if any page fails, rather than returning part of it', async () => {
    const t = pagedTable(txnRows(2366), { failOnRequest: 2 })
    const { data, error } = await read(t)
    expect(data).toBeNull()
    expect(error).toEqual({ message: 'boom' })
  })

  // postgrest-js reports a 200 (or 404) with an empty body as no data and no error. Read as an
  // empty page, that would end the read early and call it complete.
  it('treats a response with neither data nor error as a failure', async () => {
    const t = pagedTable(txnRows(2366), { emptyBodyOnRequest: 2 })
    const { data, error } = await read(t)
    expect(data).toBeNull()
    expect(error?.message).toMatch(/no data and no error/)
  })

  // A query that ignores the cursor (a broken stub, or a caller that bounded the query itself)
  // would otherwise be read forever. It has to fail, not hang and not pass.
  it('fails if a page does not move past the rows already read', async () => {
    const stuck = () => {
      const q: Record<string, unknown> = {}
      for (const m of ['order', 'or', 'limit']) q[m] = () => q
      q.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: txnRows(3), error: null }).then(resolve)
      return q
    }
    const { data, error } = await readAllRows(stuck as never)
    expect(data).toBeNull()
    expect(error?.message).toMatch(/did not advance/)
  })
})
