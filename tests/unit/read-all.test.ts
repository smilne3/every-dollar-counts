import { describe, it, expect } from 'vitest'
import { readAllRows, PAGE_SIZE } from '@/lib/read-all'

// #69: PostgREST returns at most 1,000 rows per request, with a 200 and no error. A read that
// asks for more gets the first 1,000 and renders them as though they were all of it. On
// 2026-10-05 the Settings read returned 1,000 of 1,366 transactions, and the dashboard's
// six-month window held 908 and was set to cross within weeks.

type Row = { id: string; date: string }
const rows = (n: number, start = 0): Row[] =>
  Array.from({ length: n }, (_, i) => ({ id: `t${start + i}`, date: '2026-10-01' }))

// A stand-in for a Supabase query: records what it was asked for and answers one page from
// `table`, the way PostgREST would (capped at PAGE_SIZE whatever range is requested).
function fakeTable(table: Row[], opts: { failOnPage?: number; shiftAfterPage?: number } = {}) {
  const calls: { orders: string[]; from: number; to: number }[] = []
  let current = table
  const build = () => {
    const call = { orders: [] as string[], from: -1, to: -1 }
    const q = {
      order(col: string) {
        call.orders.push(col)
        return q
      },
      range(from: number, to: number) {
        call.from = from
        call.to = to
        return q
      },
      then(resolve: (v: unknown) => unknown) {
        calls.push(call)
        const page = calls.length
        if (opts.failOnPage === page) {
          return Promise.resolve({ data: null, error: { message: 'boom' } }).then(resolve)
        }
        const data = current.slice(call.from, Math.min(call.to + 1, call.from + PAGE_SIZE))
        // A sync landing mid-read inserts a row ahead of the cursor, shifting later pages by one.
        if (opts.shiftAfterPage === page) current = [{ id: 'new', date: '2026-10-01' }, ...current]
        return Promise.resolve({ data, error: null }).then(resolve)
      },
    }
    return q
  }
  // The fake implements only what readAllRows calls; the cast stands in for Supabase's full
  // builder type.
  return { build: build as unknown as Parameters<typeof readAllRows<Row>>[0], calls }
}

describe('readAllRows', () => {
  it('reads past the 1,000-row cap until a short page', async () => {
    const t = fakeTable(rows(2366))
    const { data, error } = await readAllRows<Row>(t.build)
    expect(error).toBeNull()
    expect(data).toHaveLength(2366)
    expect(t.calls.map((c) => [c.from, c.to])).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ])
  })

  it('stops cleanly when the total is an exact multiple of the page size', async () => {
    const t = fakeTable(rows(1000))
    const { data } = await readAllRows<Row>(t.build)
    expect(data).toHaveLength(1000)
    expect(t.calls).toHaveLength(2)
  })

  it('reads a small result in one request', async () => {
    const t = fakeTable(rows(12))
    const { data } = await readAllRows<Row>(t.build)
    expect(data).toHaveLength(12)
    expect(t.calls).toHaveLength(1)
  })

  // Paging is only meaningful over a total order. `date` alone ties constantly (#50), and tied rows
  // may come back in any order, so pages could overlap or skip rows. `id` breaks the ties.
  it('orders every page by date then id', async () => {
    const t = fakeTable(rows(1500))
    await readAllRows<Row>(t.build)
    for (const c of t.calls) expect(c.orders).toEqual(['date', 'id'])
  })

  // #46: a failed read must never render as a plausible number. Returning page 1 when page 2
  // failed is exactly the silent truncation this exists to stop.
  it('fails the whole read if any page fails, rather than returning part of it', async () => {
    const t = fakeTable(rows(2366), { failOnPage: 2 })
    const { data, error } = await readAllRows<Row>(t.build)
    expect(data).toBeNull()
    expect(error).toEqual({ message: 'boom' })
  })

  it('counts a row once when a concurrent insert shifts it onto the next page', async () => {
    const t = fakeTable(rows(1500), { shiftAfterPage: 1 })
    const { data } = await readAllRows<Row>(t.build)
    const ids = data!.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain('t999')
  })
})
