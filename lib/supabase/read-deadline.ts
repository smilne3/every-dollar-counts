// How long the server waits for one request to the database before giving up on it (#202): one page of a
// paged read, or one try of a retried one. Without a limit, a request that never answers holds its page or
// API route until Vercel stops the function (300 seconds by default, as
// app/api/plaid/exchange-public-token/route.ts records), and nothing logs which read it was.
//
// A limit only has to outlast the ones Supabase applies itself, so that whatever PostgREST answers, rows or
// an error, still arrives. PostgREST waits up to 10 seconds for a free connection from its pool, its
// default, then answers 504 (PGRST003). Postgres then stops the statement at 8 seconds, Supabase's default
// statement_timeout for authenticated and, through authenticator, for service_role, and PostgREST answers
// 500 with that error. So 18 seconds in, plus the trip there and back, PostgREST has given up. Anything
// later is Supabase's edge answering for it, such as Cloudflare's 524, and cutting that off loses only an
// error. Raise this if a role's statement_timeout goes past 10 seconds.
//
// A save's own timeout in the browser is also 20 seconds (SAVE_TIMEOUT_MS in lib/save-response.ts), and it
// starts first. So when a save's read hangs, the browser says it may not have saved before the route's
// refusal arrives. That's the safe thing to say, since the browser can't tell.
export const READ_DEADLINE_MS = 20_000

function isDatabaseRead(input: RequestInfo | URL, init?: RequestInit) {
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
  // Only reads, because a write that's cut off may still have happened, and the caller couldn't tell. That
  // leaves Supabase Auth's session refresh alone too: it's a POST, which auth-js retries for about 25
  // seconds on purpose (proxy.ts, #143). Only PostgREST, so getUser()'s GET /auth/v1/user, the sign-in
  // check, has no limit either. Nor do the app's .rpc() calls, rename_category and delete_category
  // (app/api/categories/route.ts): each is a POST, and each writes.
  if (method !== 'GET' && method !== 'HEAD') return false
  try {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    return new URL(url).pathname.startsWith('/rest/v1/')
  } catch {
    // Left to fetch, which fails a URL it can't use as it always has. Thrown here, the error would reach
    // auth-js too, which shares this fetch, and read as Supabase Auth being unreachable.
    return false
  }
}

// The fetch for the server-side Supabase clients. A read past its limit then fails the way any other
// failed read does: postgrest-js returns { error: { message: 'AbortError: …' } }, and the caller handles it
// as its own. A page throws its "could not read <what>" error, which Next logs with the digest the error
// card shows.
//
// An AbortError, not the TimeoutError that AbortSignal.timeout() gives: postgrest-js retries a read whose
// fetch fails, up to 3 times, after 1, 2 and 4 seconds. An AbortError stops that, but a TimeoutError only
// when the query's own .abortSignal() fired, and a signal made here isn't that one. So a TimeoutError would
// run the whole limit four times, with 7 seconds of waiting between. Passing the AbortError as the abort's
// reason makes a read that stalls partway through its body fail the same way, which a catch around fetch()
// wouldn't reach.
//
// Keep it wrapped in an Error of the caller's own, as every caller does today. Next ignores a thrown error
// named AbortError, taking it for a request the browser gave up on, so it would log nothing and the error
// card would have no Error ID. A query using .throwOnError() would throw this one as it is.
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

    // The caller's own signal still works: a query's .abortSignal(), or a Request's.
    const own = init?.signal ?? (input instanceof Request ? input.signal : undefined)
    const signal = own ? AbortSignal.any([own, deadline.signal]) : deadline.signal
    return fetch(input, { ...init, signal })
  }
}

export const fetchWithReadDeadline = fetchWithDeadline(READ_DEADLINE_MS)
