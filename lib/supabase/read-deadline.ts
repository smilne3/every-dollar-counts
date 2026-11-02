// How long the server waits for one database read before giving up on it (#202). Without a limit, a read
// that never answers holds the page until Vercel stops the function, up to five minutes, and nothing logs
// which read it was.
//
// A limit only has to be longer than the limits Supabase applies itself, so a slow read it would have
// answered is never cut off. PostgREST waits up to 10 seconds for a free database connection and answers
// 504 (PGRST003). Postgres then stops a statement at 8 seconds, the default for authenticated and for
// service_role, and PostgREST answers with that error. So past 18 seconds, plus the trip there and back,
// Supabase has gone quiet. Each request gets its own limit, so a paged read's total isn't capped.
export const READ_DEADLINE_MS = 20_000

function isDatabaseRead(input: RequestInfo | URL, init?: RequestInit) {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
  // Only PostgREST, because auth-js retries a session refresh for about 25 seconds on purpose (proxy.ts,
  // #143). Only reads, because a write that's cut off may still have happened, and the caller couldn't
  // tell. The app has no read that goes through POST /rpc.
  return new URL(url).pathname.startsWith('/rest/v1/') && (method === 'GET' || method === 'HEAD')
}

// The fetch for a server-side Supabase client. The read then fails the way any other failed read does:
// postgrest-js returns { error: { message: 'AbortError: …' } }, and the caller's own check throws its
// "could not read <what>" error, which Next logs with the digest the error card shows.
//
// An AbortError, not the TimeoutError that AbortSignal.timeout() gives: postgrest-js retries a read whose
// fetch fails, up to 3 times, after 1, 2 and 4 seconds, and only an AbortError stops that. A TimeoutError
// would run the whole limit four times. Passing it as the abort's reason makes a read that stalls partway
// through its body fail the same way, which a catch around fetch() wouldn't reach.
export function fetchWithDeadline(deadlineMs: number): typeof fetch {
  return (input, init) => {
    if (!isDatabaseRead(input, init)) return fetch(input, init)

    const deadline = new AbortController()
    const timer = setTimeout(() => {
      deadline.abort(new DOMException(`Supabase gave no answer within ${deadlineMs / 1000} seconds`, 'AbortError'))
    }, deadlineMs)
    // Left to fire after the read has finished, when aborting does nothing. It only mustn't keep the
    // process alive.
    timer.unref()

    const signal = init?.signal ? AbortSignal.any([init.signal, deadline.signal]) : deadline.signal
    return fetch(input, { ...init, signal })
  }
}

export const fetchWithReadDeadline = fetchWithDeadline(READ_DEADLINE_MS)
