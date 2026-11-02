// @vitest-environment node
// jsdom replaces AbortController and Request with its own, which Node's fetch refuses. The server runs
// on Node's, so these tests do too.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createClient } from '@supabase/supabase-js'
import { readAllRows, type PageableQuery } from '@/lib/read-all'
import { fetchWithDeadline, fetchWithReadDeadline, READ_DEADLINE_MS } from '@/lib/supabase/read-deadline'

// #202: real supabase-js over real sockets, against a loopback server that can stay silent. The retries
// and the error shape these tests depend on are postgrest-js's own, so a stubbed fetch would only test
// this file's idea of them. The limit is short, and each delay is a multiple of it.
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
// Each request takes the next answer, and the last one repeats.
const server = createServer((req, res) => {
  requests.push({ method: req.method ?? '', path: new URL(req.url ?? '/', 'http://x').pathname })
  req.resume()
  // Not kept alive: afterEach closes every connection, and the next test's fetch could land on a closed one.
  res.setHeader('connection', 'close')
  const answer = answers.length > 1 ? answers.shift()! : answers[0]
  answer(res, req)
})
let url = ''

function client(deadlineMs = LIMIT) {
  return createClient(url, 'made-up-key', {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: fetchWithDeadline(deadlineMs) },
  })
}

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(async () => {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
})
beforeEach(() => {
  answers = []
  requests = []
})
afterEach(() => {
  vi.useRealTimers()
  server.closeAllConnections()
})

const NO_ANSWER = `AbortError: Supabase gave no answer within ${LIMIT / 1000} seconds`

describe('a database read past its time limit (#202)', () => {
  it('reads as normal when the answer comes in time', async () => {
    answers = [after(WITHIN_LIMIT, json([{ id: 'a1' }]))]
    const { data, error } = await client().from('accounts').select('id')
    expect(error).toBeNull()
    expect(data).toEqual([{ id: 'a1' }])
  })

  // Once, not four times: a read whose fetch fails is retried, and only an AbortError stops that.
  it('fails with an error naming the limit when no answer comes, and is not retried', async () => {
    answers = [never]
    const { data, error } = await client().from('accounts').select('id')
    expect(data).toBeNull()
    expect(error?.message).toBe(NO_ANSWER)
    expect(requests).toEqual([{ method: 'GET', path: '/rest/v1/accounts' }])
  })

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
    // By its delay, because Node's HTTP client sets timers of its own.
    const index = setTimeoutSpy.mock.calls.findIndex(([, ms]) => ms === 60_000)
    const timer = setTimeoutSpy.mock.results[index].value as NodeJS.Timeout
    setTimeoutSpy.mockRestore()
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

  // auth-js retries a session refresh for about 25 seconds on purpose (proxy.ts, #143).
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
})

describe('READ_DEADLINE_MS (#202)', () => {
  // Supabase's own limits: PostgREST's 10 seconds for a connection (db-pool-acquisition-timeout), then
  // Postgres's 8 for a statement. Below their sum, this would cut off a read Supabase would have answered.
  it('is longer than the limits Supabase applies itself', () => {
    expect(READ_DEADLINE_MS).toBeGreaterThan(18_000)
  })

  it('is the limit the fetch uses', async () => {
    answers = [never]
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    let settled = false
    const read = fetchWithReadDeadline(`${url}/rest/v1/accounts`).then(
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
    expect(await read).toMatchObject({
      name: 'AbortError',
      message: `Supabase gave no answer within ${READ_DEADLINE_MS / 1000} seconds`,
    })
  })
})
