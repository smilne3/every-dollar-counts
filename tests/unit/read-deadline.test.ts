// @vitest-environment node
// The server runs on Node, so these tests do too.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createClient } from '@supabase/supabase-js'
import { readAllRows, type PageableQuery } from '@/lib/read-all'
import { fetchWithDeadline, fetchWithReadDeadline, READ_DEADLINE_MS } from '@/lib/supabase/read-deadline'

// #202: real supabase-js over real sockets, against a loopback server that can stay silent. The retries
// and the error shape these tests depend on are postgrest-js's own, so a stubbed fetch would only test
// this file's idea of them. The limit is short: an answer in time comes at 250ms, a late one at twice the
// limit.
const LIMIT = 400
const WITHIN_LIMIT = 250
const PAST_LIMIT = 800

type Answer = (res: ServerResponse, req: IncomingMessage) => void

const json = (body: unknown, status = 200) => (res: ServerResponse) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
const after = (ms: number, answer: Answer): Answer => (res, req) => {
  setTimeout(() => answer(res, req), ms)
}
const never: Answer = () => {}

let answers: Answer[] = []
let requests: { method: string; path: string }[] = []
// A server of its own for each test, on a port of its own. fetch pools connections by origin, and after an
// aborted request it can leave a spare one open, so a shared server let a test's request go out on a
// connection the test before had closed (seen on Node 22, which CI runs).
let server: ReturnType<typeof createServer>
let url = ''

// Every attempt postgrest-js makes, counted as it's made. The server's count misses an attempt that dies on
// the way, such as one sent on a socket that's already closed, and postgrest-js retries those.
let attempts: string[] = []
function client(deadlineMs = LIMIT) {
  const limited = fetchWithDeadline(deadlineMs)
  return createClient(url, 'made-up-key', {
    auth: { autoRefreshToken: false, persistSession: false },
    global: {
      fetch: (input, init) => {
        attempts.push(`${init?.method ?? 'GET'} ${new URL(input instanceof Request ? input.url : input).pathname}`)
        return limited(input, init)
      },
    },
  })
}

beforeEach(async () => {
  answers = []
  requests = []
  attempts = []
  // Each request takes the next answer, and the last one repeats.
  server = createServer((req, res) => {
    requests.push({ method: req.method ?? '', path: new URL(req.url ?? '/', 'http://x').pathname })
    req.resume()
    const answer = answers.length > 1 ? answers.shift()! : answers[0]
    answer(res, req)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
})

const NO_ANSWER = `AbortError: Supabase gave no answer within ${LIMIT / 1000} seconds`

describe('a database read past its time limit (#202)', () => {
  it('reads as normal when the answer comes in time', async () => {
    answers = [after(WITHIN_LIMIT, json([{ id: 'a1' }]))]
    const { data, error } = await client().from('accounts').select('id')
    expect(error).toBeNull()
    expect(data).toEqual([{ id: 'a1' }])
  })

  // Once, not four times: postgrest-js retries a read whose fetch fails, but not one that fails with an
  // AbortError. Counted where postgrest-js makes them, so an attempt that never reached the server counts
  // too, and given time for all three retries (1 + 2 + 4 seconds of waiting), so a retry fails here as
  // extra attempts rather than as a timeout.
  it('fails with an error naming the limit when no answer comes, and is not retried', async () => {
    answers = [never]
    const { data, error } = await client().from('accounts').select('id')
    expect(attempts).toEqual(['GET /rest/v1/accounts'])
    expect(data).toBeNull()
    expect(error?.message).toBe(NO_ANSWER)
    expect(requests).toEqual([{ method: 'GET', path: '/rest/v1/accounts' }])
  }, 15_000)

  it('fails the same way when the answer stalls partway through', async () => {
    answers = [
      (res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.write('[{"id":')
      },
    ]
    const { data, error } = await client().from('accounts').select('id')
    expect(data).toBeNull()
    expect(error?.message).toBe(NO_ANSWER)
    expect(requests).toHaveLength(1)
  })

  it('covers a read that only asks for a count', async () => {
    answers = [never]
    const { count, error } = await client().from('accounts').select('id', { count: 'exact', head: true })
    expect(attempts).toEqual(['HEAD /rest/v1/accounts'])
    expect(count).toBeNull()
    expect(error?.message).toBe(NO_ANSWER)
    expect(requests).toEqual([{ method: 'HEAD', path: '/rest/v1/accounts' }])
  })

  // The limit is on each request, so a long household history can't fail a healthy paged read.
  it('applies to each page of a paged read, not to the whole of it', async () => {
    const row = { id: 't1', date: '2026-01-01' }
    answers = [after(WITHIN_LIMIT, json([row])), after(WITHIN_LIMIT, json([{ ...row, id: 't2' }])), after(WITHIN_LIMIT, json([]))]
    const started = performance.now()
    const db = client()
    const { data, error } = await readAllRows(
      () => db.from('transactions').select('id, date') as unknown as PageableQuery<typeof row>
    )
    expect(error).toBeNull()
    expect(data?.map((r) => r.id)).toEqual(['t1', 't2'])
    expect(requests).toHaveLength(3)
    expect(performance.now() - started).toBeGreaterThan(LIMIT)
  })

  it('fails a paged read when a later page gets no answer', async () => {
    const row = { id: 't1', date: '2026-01-01' }
    answers = [json([row]), never]
    const db = client()
    const { data, error } = await readAllRows(
      () => db.from('transactions').select('id, date') as unknown as PageableQuery<typeof row>
    )
    expect(data).toBeNull()
    expect(error?.message).toBe(NO_ANSWER)
  })

  // postgrest-js's own retry of a 503 still happens, and the retry gets a whole limit of its own.
  it('starts again for a read that postgrest-js retries', async () => {
    const unavailable: Answer = (res) => {
      res.writeHead(503, { 'retry-after': '0' })
      res.end()
    }
    answers = [after(WITHIN_LIMIT, unavailable), after(WITHIN_LIMIT, json([{ id: 'a1' }]))]
    const { data, error } = await client().from('accounts').select('id')
    expect(error).toBeNull()
    expect(data).toEqual([{ id: 'a1' }])
    expect(requests).toHaveLength(2)
  })

  it("still stops when the query's own signal aborts first", async () => {
    answers = [never]
    const controller = new AbortController()
    setTimeout(() => controller.abort(new DOMException('the caller gave up', 'AbortError')), WITHIN_LIMIT)
    // A limit far longer than the test, so only the caller's signal can end this read.
    const { error } = await client(60_000).from('accounts').select('id').abortSignal(controller.signal)
    expect(error?.message).toBe('AbortError: the caller gave up')
  })

  it("still applies when the query has a signal of its own that doesn't abort", async () => {
    answers = [never]
    const { error } = await client().from('accounts').select('id').abortSignal(new AbortController().signal)
    expect(error?.message).toBe(NO_ANSWER)
  })

  // The timer outlives a read that finishes in time, so it mustn't keep a process alive.
  it("doesn't hold the process open while it waits", async () => {
    answers = [json([])]
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    await fetchWithDeadline(60_000)(`${url}/rest/v1/accounts`)
    // By its delay, because Node's HTTP client sets timers of its own. afterEach restores the spy.
    const index = setTimeoutSpy.mock.calls.findIndex(([, ms]) => ms === 60_000)
    expect(index).toBeGreaterThanOrEqual(0)
    const timer = setTimeoutSpy.mock.results[index].value as NodeJS.Timeout
    expect(timer.hasRef()).toBe(false)
  })
})

describe('what the limit leaves alone (#202)', () => {
  // A write that's cut off may still have happened, and the caller couldn't tell.
  it.each([
    ['insert', 'POST', (db: ReturnType<typeof client>) => db.from('budgets').insert({ category: 'c1' })],
    ['update', 'PATCH', (db: ReturnType<typeof client>) => db.from('budgets').update({ category: 'c1' }).eq('id', 'b1')],
    ['upsert', 'POST', (db: ReturnType<typeof client>) => db.from('budgets').upsert({ id: 'b1' })],
    ['delete', 'DELETE', (db: ReturnType<typeof client>) => db.from('budgets').delete().eq('id', 'b1')],
    ['function call', 'POST', (db: ReturnType<typeof client>) => db.rpc('some_function')],
  ])('waits for a slow %s', async (_, method, write) => {
    answers = [after(PAST_LIMIT, json(null, 201))]
    const { error } = await write(client())
    expect(error).toBeNull()
    expect(requests).toHaveLength(1)
    expect(requests[0].method).toBe(method)
  })

  // getUser() is a GET, so only the path check keeps Supabase Auth out of the limit.
  it('waits for a slow answer from Supabase Auth', async () => {
    answers = [after(PAST_LIMIT, json({ id: 'user-1', aud: 'authenticated' }))]
    const { data, error } = await client().auth.getUser('made-up-token')
    expect(error).toBeNull()
    expect(data.user?.id).toBe('user-1')
    expect(requests).toEqual([{ method: 'GET', path: '/auth/v1/user' }])
  })
})

describe('fetchWithDeadline: what it was called with (#202)', () => {
  const limited = fetchWithDeadline(LIMIT)
  const noAnswer = { name: 'AbortError', message: `Supabase gave no answer within ${LIMIT / 1000} seconds` }

  it.each([
    ['a string', () => `${url}/rest/v1/accounts`],
    ['a URL', () => new URL(`${url}/rest/v1/accounts`)],
    ['a Request', () => new Request(`${url}/rest/v1/accounts`)],
  ])('limits a read given as %s', async (_, input) => {
    answers = [never]
    await expect(limited(input())).rejects.toMatchObject(noAnswer)
  })

  it("takes a Request's own method, and leaves a write alone", async () => {
    answers = [after(PAST_LIMIT, json(null, 201))]
    const res = await limited(new Request(`${url}/rest/v1/budgets`, { method: 'POST', body: '{}' }))
    expect(res.status).toBe(201)
  })

  it('lets init name the method', async () => {
    answers = [after(PAST_LIMIT, json(null, 201))]
    const res = await limited(`${url}/rest/v1/budgets`, { method: 'POST', body: '{}' })
    expect(res.status).toBe(201)
  })

  it('limits a read whose method is in lower case', async () => {
    answers = [never]
    await expect(limited(`${url}/rest/v1/accounts`, { method: 'get' })).rejects.toMatchObject(noAnswer)
  })

  // Thrown, it would reach auth-js too, which shares this fetch, and read as Supabase Auth being down.
  it('leaves a URL it cannot read to fetch, rather than throwing', async () => {
    let call: Promise<Response> | undefined
    expect(() => (call = limited('not a url'))).not.toThrow()
    await expect(call).rejects.toThrow(TypeError)
  })

  it("keeps a Request's own signal", async () => {
    answers = [never]
    const controller = new AbortController()
    controller.abort(new DOMException('the caller gave up', 'AbortError'))
    await expect(limited(new Request(`${url}/rest/v1/accounts`, { signal: controller.signal }))).rejects.toMatchObject({
      message: 'the caller gave up',
    })
    expect(requests).toEqual([])
  })
})

describe('READ_DEADLINE_MS (#202)', () => {
  // Supabase's own limits: PostgREST's 10 seconds for a connection (db-pool-acquisition-timeout), then the
  // 8-second statement_timeout Supabase sets for authenticated and, through authenticator, service_role. At
  // or below their sum, this could cut off a read PostgREST would still have answered.
  it('is longer than the limits Supabase applies itself', () => {
    expect(READ_DEADLINE_MS).toBeGreaterThan(18_000)
  })

  // No socket: a fetch that ends only when its signal aborts. Fake time over a real connection also runs the
  // HTTP client's own timers, and its 10-second connect timeout fired first whenever this test ran alone.
  it('is the limit the fetch uses', async () => {
    vi.stubGlobal('fetch', (_: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)))
    )
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    let settled = false
    const read = fetchWithReadDeadline('http://127.0.0.1:9/rest/v1/accounts').then(
      () => (settled = true),
      (e: unknown) => {
        settled = true
        return e
      }
    )

    vi.advanceTimersByTime(READ_DEADLINE_MS - 1)
    await new Promise((resolve) => setImmediate(resolve))
    expect(settled).toBe(false)

    vi.advanceTimersByTime(1)
    await new Promise((resolve) => setImmediate(resolve))
    expect(settled).toBe(true)
    expect(await read).toMatchObject({
      name: 'AbortError',
      message: `Supabase gave no answer within ${READ_DEADLINE_MS / 1000} seconds`,
    })
  })
})
