// What postgrest-js gives a write whose request failed in flight (#173). It retries a GET, HEAD or
// OPTIONS but never a POST, PATCH or DELETE, so the write comes back once, with no HTTP status and
// no code (node_modules/@supabase/postgrest-js/dist/index.mjs, the catch in PostgrestBuilder's
// then). The message is the fetch error's, named, and Node's fetch fails with a TypeError; `details`
// names the cause. A route's stand-in resolves a write to this to show the route a database that
// never answered.
export const NO_ANSWER = {
  data: null,
  error: {
    message: 'TypeError: fetch failed',
    details: 'TypeError: fetch failed\n\nCaused by: Error: connect ECONNREFUSED 127.0.0.1:443 (ECONNREFUSED)',
    hint: '',
    code: '',
  },
  count: null,
  status: 0,
  statusText: '',
}

// A gateway's error page in PostgREST's place, as postgrest-js reads it: the page's status, its text
// as the message, and no code. The API gateway's 502 says PostgREST gave it no valid answer, and
// Cloudflare's 520 that the origin answered something it could not read. Either can come after the
// write committed, so neither is a refusal.
const gatewayPage = (status: number, statusText: string, page: string) => ({
  data: null,
  error: { message: page },
  count: null,
  status,
  statusText,
})
export const GATEWAY_502 = gatewayPage(502, 'Bad Gateway', '<html><body>502 Bad Gateway</body></html>')
export const GATEWAY_520 = gatewayPage(520, '', '<html><body>Web server is returning an unknown error</body></html>')

// A refusal with a 5xx status: a statement that ran past its timeout and was cancelled, so nothing
// was written. PostgREST answers it 500, with Postgres's code, which is what tells it from a gateway.
export const REFUSED_5XX = {
  data: null,
  error: { code: '57014', message: 'canceling statement due to statement timeout', details: null, hint: null },
  count: null,
  status: 500,
  statusText: 'Internal Server Error',
}
