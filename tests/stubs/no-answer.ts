// What postgrest-js gives a write whose request failed in flight (#173). It retries a GET, HEAD or
// OPTIONS but never a POST, PATCH or DELETE, so the write comes back once, with no HTTP status and
// no code (node_modules/@supabase/postgrest-js/dist/index.mjs, the catch in PostgrestBuilder's
// then). The message is the fetch error's, named, and Node's fetch fails with a TypeError. A route's
// stand-in resolves a write to this to show the route a database that never answered.
export const NO_ANSWER = {
  data: null,
  error: { message: 'TypeError: fetch failed', details: '', hint: '', code: '' },
  count: null,
  status: 0,
  statusText: '',
}
